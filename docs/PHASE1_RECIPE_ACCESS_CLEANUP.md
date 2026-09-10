# Phase 1 recipe access and index cleanup

## Why this change is needed

Hosted PR30 validation found two performance warnings on `recipe_ingredients`.
Review showed that the policy warning also identifies an access-rule defect:
the Phase 1 recipe hardening drops `active staff read recipe ingredients`,
but the earlier dynamically generated policy is named
`active staff read recipe_ingredients`. The remaining staff policy permits
active bartenders and viewers to query canonical ingredient rows directly.

The intended design, stated by the recipe hardening migration and implemented
by the frontend, reserves canonical recipes and ingredients for managers/admins.
Active staff obtain operational recipe and ingredient fields through
`public.recipe_catalog`.

## Proposed change

The new incremental migration was generated with Supabase CLI 2.117.0:
`20260910104621_atlas_phase1_recipe_access_and_index_cleanup.sql`.

- Remove the precisely named stale staff SELECT policy. Keep the manager policy,
  write policies, grants and recipe catalogue function/view unchanged.
- Remove `recipe_ingredients_recipe_idx`, retaining the identical
  `recipe_ingredients_recipe_id_idx` index. Check the retained index, structural
  equivalence, access method and constraint dependencies before removal.
- Refuse unexpected policy/index shapes rather than guessing how to repair them.

The PR30 flattened migration and its source files remain unchanged. This is an
additional migration, applied after either historical replay or exact PR30 adoption.
The migration removes no data and does not change Auth, Storage, endpoints or
Edge Functions. It requires the already-established Phase 1 policy/index shape.

## Verification

A new empty-preview transaction test covers 14 assertions:

- Canonical ingredient reads: admin/manager allowed; bartender/viewer/inactive/
  unlisted users denied; anon has no direct SELECT grant.
- Operational ingredient catalogue reads: admin, manager, bartender and viewer
  retain the fixture ingredient.
- Only the manager SELECT policy remains, the duplicate index is absent, and
  the retained recipe lookup index exists.

The test raises an exception on any failed assertion and rolls back all fixture
users, profiles, recipes and ingredients. It must never run on production.

On isolated project `atialqebqxcquzdkezln`, before the fix, the regression test
failed for bartender/viewer canonical reads and the two structural checks.
With the exact proposed SQL in a rollback-only transaction, all 14 passed.
This did not persist the proposed policy/index changes or add a migration entry.

CI runs the new checks after all historical migrations, alongside the original
20 role checks and security gate. The production-adoption workflow first tests
the unchanged PR30 candidate, then applies this follow-up and runs the new
regression suite in its disposable PostgreSQL service.

## Scope remaining for production planning

The current hosted staging baseline remains at PR30 until a separate persistent
staging application is authorized. This draft does not authorize merge or
production execution. Index/policy DDL takes locks; the maintenance plan must
account for that before production application.

The four missing-FK-index INFO findings, 18 unused-index INFO findings and
default Auth connection strategy INFO finding are outside this targeted fix.
An empty staging database provides no representative workload for pruning
indexes. Current production data and backup/restore evidence still require their
own review before any production rollout.

Advisor references: [policy overlap](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies),
[duplicate indexes](https://supabase.com/docs/guides/database/database-linter?lint=0009_duplicate_index).
