# Phase 1 production migration split — acceptance evidence

## Scope

This record closes the technical defect where the production security migration
attempted to create views backed by the isolated Atlas L1 schema.

## Result

The migration path is now separated by database ownership:

- production security controls live in
  `20260806104705_atlas_phase1_profiles_security_gate.sql`;
- Atlas-only verified-stock views live in
  `20260806165146_atlas_phase1_stock_count_views_branch_only.sql`;
- the exact earlier preview-applied SQL is archived outside the executable
  migration directory for provenance.

## Acceptance performed

### Production schema preflight

Read-only checks against production confirmed:

- all required columns exist;
- `public.profiles` is canonical;
- `public.staff` and `atlas_private` are absent;
- the complete role enum exists;
- two active administrators exist;
- no Phase 1 migration is installed;
- fingerprint: 49 inventory rows, 49 active rows, 131.2 quantity and 12 movements.

### Exact production migration dry run

The exact production-safe migration executed on the isolated preview inside one
transaction and was rolled back. It confirmed:

- no public table lacked RLS;
- anonymous direct inventory access was absent;
- anonymous `public_menu` access remained present;
- `public_menu` exposed exactly four approved columns;
- redacted inventory and movement catalogues existed;
- no production-local stock-count view was part of the migration.

### Production-topology no-op test

Inside another rollback-only preview transaction, the Atlas source schema was
hidden and existing count views were removed. The guarded branch migration then
confirmed:

- source available: false;
- staff count view created: false;
- manager count view created: false;
- production no-op result: passed.

### Role and security verification

- preview role matrix: 18 passed, 0 failed, rolled back;
- tables without RLS: none;
- unsafe non-public views: none;
- unintended browser-callable public functions: none;
- preview fixtures after testing: zero.

## Production mutation

None. No production migration, data update, quantity change, inventory movement
or role change occurred during this acceptance.

## Open gates

This record does not authorize production migration. Dashboard security evidence,
SMTP delivery, the temporary Edge Function deletion, control-plane branch status,
a fresh final backup and production browser acceptance remain required.
