# Phase 1 production migration split — acceptance evidence

## Scope

This record closes the defect where production security SQL depended on the
isolated Atlas L1 schema, and the two Supabase linter findings discovered during
final security review.

## Final migration ownership

- production authorization and RLS foundation:
  `20260806104705_atlas_phase1_profiles_security_gate.sql`;
- guarded Atlas-only verified-stock views:
  `20260806165146_atlas_phase1_stock_count_views_branch_only.sql`;
- public-menu and adjustment RPC lint closure:
  `20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql`.

## Acceptance performed

### Production schema preflight

All required columns exist. `public.profiles` is canonical, `public.staff` and
`atlas_private` are absent, all four application roles exist, two active admins
exist, and production has no Phase 1 migration installed.

### Exact production migration dry run

The production-safe migration executed on preview inside one transaction and was
rolled back. It confirmed RLS, anonymous menu access, anonymous inventory denial,
redacted catalogue creation, four-column menu shape and no local stock-count view.

### Production-topology no-op

The Atlas source schema was hidden in a rollback-only transaction. The guarded
stock migration created neither staff nor manager view and reported a successful
production no-op.

### Security-lint closure

The preview advisor originally reported an owner-evaluated `public_menu` view and
an authenticated SECURITY DEFINER `adjust_inventory` RPC. Migration 171317
replaced both patterns. After application, the Supabase security advisor returned
an empty finding list.

### Role matrix

The complete rollback-only role matrix passed **20 of 20** checks. The two new
checks prove that a bartender cannot call the controlled adjustment RPC and an
admin adjustment creates exactly one movement while changing the fixture
quantity. All fixtures were rolled back.

## Production mutation

None. Production remains at 49 inventory rows, 49 active rows, 131.2 quantity and
12 movements.

## Open gates

This record does not authorize production migration. The final CI run, SMTP
acceptance, dashboard security evidence, temporary function deletion, stale
Supabase branch status, fresh pre-window backup and production browser acceptance
remain required.
