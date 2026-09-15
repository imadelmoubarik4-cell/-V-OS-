# Phase 1 — VÁ OS / Atlas security gate

## Decision

`public.profiles` is the single authorization registry. The business owner maps
to `admin`; `manager` and `bartender` remain operational roles; `viewer` is
retained as read-only compatibility. `public.staff` must not coexist.

The database is the authoritative boundary. Browser hiding is usability only.

## Production-compatible migration ownership

The executable production migration
`20260806104705_atlas_phase1_profiles_security_gate.sql` contains no
`atlas_private` reference. It installs only production-owned authorization,
RLS, grants, audit, inventory, recipe and public-menu controls.

The exact earlier SQL already applied to the Atlas preview is preserved outside
the executable migration directory at:

`docs/security/preview-applied/20260806104705_atlas_phase1_profiles_security_gate.preview.sql`

The Atlas-only L1 views are owned by the guarded migration:

`20260806165146_atlas_phase1_stock_count_views_branch_only.sql`

It creates `stock_count_summary` and `stock_count_manager_summary` only when
`atlas_private.inventory_verified_balances` exists. Production does not own that
source relation, so the migration is an intentional no-op there and L1 remains
available through the authenticated Atlas gateway.

The final security-lint migration is:

`20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql`

It replaces the owner-evaluated menu view with a security-invoker view over a
trigger-maintained four-column projection in the non-exposed
`public_menu_private` schema. It also makes `adjust_inventory` security-invoker,
adds the manager-only movement insert policy and keeps the immutable movement
boundary.

## Preview implementation and acceptance

Latest database acceptance:

- preview role matrix: **20 passed, 0 failed, rolled back**;
- exact production-safe migration: **executed successfully, rolled back**;
- production-topology stock-view test: **guarded migration performed a no-op**;
- security advisors after lint closure: **zero findings**;
- preview security verification: no table without RLS, no unsafe non-public view,
  no unintended browser-callable function and no `security_lint_blockers`;
- preview fixtures after testing: zero Auth users, profiles, inventory rows,
  quantity and movements;
- `public_menu`: security-invoker, exactly `id`, `name`, `type` and `menu_price`;
- public menu client: isolated anonymous session with explicit four-field query;
- bartender controlled adjustment: denied;
- manager controlled adjustment: passed and created one movement inside the
  rollback-only fixture;
- redacted inventory, movement, recipe and stock-count projections present.

The Supabase preview database is active and healthy. Its branch control-plane
metadata still carries the historical `MIGRATIONS_FAILED` label from the earlier
deployment incident. That metadata state must be refreshed, reset or explicitly
resolved before PR #5 leaves draft even though the database ledger and
transactional acceptance now pass.

## Authentication and email-delivery gates

Owner-confirmed in the production Supabase dashboard:

- [x] Email signup disabled.
- [x] Email confirmation enabled.
- [x] Leaked-password protection enabled.
- [x] Minimum password length is at least 10.
- [x] Custom SMTP configured.
- [x] Current roster reconciled: three active accounts are intentional.
- [x] Two future staff accounts will be invited later through an administrator-only
  server-side Atlas workflow and will start inactive.
- [ ] Invitation delivery confirmed through the custom SMTP provider.
- [ ] Password-reset delivery confirmed through the custom SMTP provider.
- [ ] JWT expiry and Auth rate limits reviewed and recorded.

Still required outside the repository:

- [ ] 2FA enabled on Supabase, GitHub and Netlify.
- [ ] GitHub Secret scanning and Push protection enabled.
- [ ] Branch ruleset confirmed active on `main` and the current release base.
- [ ] Netlify environment variables and build hooks reviewed.
- [ ] Temporary production function `atlas-backup-export-20260806` deleted from
  the Supabase dashboard; its current deployed body is JWT-gated and returns 410.

## Backup and rollback evidence

The encrypted off-repository backup and rollback package has been created. It
contains logical data, sanitized Auth metadata, schema/security metadata,
migration history, fingerprints, verification SQL, authorization rollback SQL
and an emergency data-restore generator. The archive and encryption key must be
stored separately and must never enter the public repository.

Captured production baseline:

- inventory records: **49**
- active inventory records: **49**
- summed quantity: **131.2**
- inventory movements: **12**
- active profiles: **3**
- active administrators: **2**

The read-only production schema preflight passed with no required column missing,
no competing `staff` table, no `atlas_private` schema and no Phase 1 migration
already applied.

## Schema-change rule

All future schema changes must use reviewed migrations. Do not create operational
tables from the Supabase Dashboard. The Phase 1 migration closes current grants
and the default privileges of the migration role; the managed `supabase_admin`
default ACL cannot be changed by the normal migration runner. The verification
query is therefore mandatory after every migration and must fail the release if
a new public table lacks RLS or a new view is exposed unsafely.

## Production order

1. Confirm SMTP invitation and password-reset delivery.
2. Confirm JWT/rate-limit review, 2FA, GitHub security settings, branch rules and
   Netlify review.
3. Delete the temporary backup Edge Function.
4. Verify `imadelmoubarik4@gmail.com` remains an active `admin`.
5. Take a fresh final backup immediately before the window.
6. Freeze operational writes briefly and capture the fingerprint.
7. Apply migrations in repository order through
   `20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql`.
8. Run `scripts/verify_phase1_security_gate.sql`; every exception list and
   `security_lint_blockers` must be empty.
9. Deploy the browser and Netlify hardening commit.
10. Run the production browser role matrix.
11. Re-run the fingerprint and compare it with the baseline.
12. Keep PR #5 draft until every result is recorded.

## Role acceptance matrix

| Test | Expected |
|---|---|
| Logged-out visitor opens `menu.html` | Allowed |
| Anonymous inventory query | Denied |
| Unlisted or inactive account | No Atlas access |
| Bartender reads inventory | Redacted `inventory_catalog` only |
| Bartender reads recipe | Redacted `recipe_catalog` only |
| Bartender reads cost, supplier terms or variance identity | Denied |
| Bartender records an L1 observation | Allowed |
| Bartender calls controlled live adjustment | Denied |
| Bartender changes cost or deletes an item | Denied |
| Manager reads commercial fields | Allowed |
| Manager calls controlled adjustment | Allowed and movement recorded |
| Manager publishes an approved count | Controlled L1 publication only |
| Browser calls private L1/L2 tables | Denied |
| Preview publication | Blocked |
| L2 publication changes quantity or creates a movement | Never |

## Rollback

Do not restore the old permissive policies as an emergency shortcut. Roll back
the web deployment first, then use the encrypted pre-migration package to restore
the captured authorization state inside a maintenance window. The production
migration is designed to fail before changing policy when there is no active
administrator.
