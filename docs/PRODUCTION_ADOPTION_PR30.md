# PR30 flattened Phase 1 migration gate

## Status

PR30 creates the reviewed Phase 1 candidate as one normal Supabase migration
file in Git. It does not authorize or perform a hosted database operation.

The migration was generated with `supabase migration new` from merged base
commit `67ba67080f7f92bfe1e6324c3c971c490bfdc6cc`, then populated by flattening
the exact deployable SQL approved in PR28.

## Flattened source order

1. `supabase/production-adoption/sql/010_rls_auto_enable_hardening.sql`
2. `supabase/migrations/20260802090000_phase_a_02_inventory_staging.sql`
3. `supabase/migrations/20260806104705_atlas_phase1_profiles_security_gate.sql`
4. `supabase/migrations/20260806105543_atlas_phase1_recipe_catalog_gate.sql`
5. `supabase/migrations/20260806151244_atlas_phase1_recipe_catalog_runtime_fix.sql`
6. `supabase/migrations/20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql`

The generated migration contains no psql include or variable commands. The
PR28 preflight and verification files remain assertions around the migration;
they are not deployment statements and are not embedded in it.

## Git-only boundary

This pull request does not:

- create or pay for a Supabase staging branch;
- execute SQL against a hosted database;
- deploy or alter Edge Functions;
- change `apps/web/config.js` or any runtime endpoint;
- modify production data, schema, configuration or migration history.

## Required next approval

After review and local disposable-PostgreSQL validation, applying this exact
migration to an authorized production-shaped staging target requires a
separate approval. Production SQL, functions and endpoint cutover each remain
separate later gates.
