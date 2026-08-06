# Phase 1 — VÁ OS / Atlas security gate

## Decision

`public.profiles` is the single authorization registry. The business owner maps
to `admin`; `manager` and `bartender` remain operational roles; `viewer` is
retained as read-only compatibility. `public.staff` must not coexist.

The database is the authoritative boundary. Browser hiding is usability only.

## Preview implementation

The isolated Atlas Supabase branch contains:

- `20260806104705_atlas_phase1_profiles_security_gate.sql`
- `20260806105543_atlas_phase1_recipe_catalog_gate.sql`
- `20260806151244_atlas_phase1_recipe_catalog_runtime_fix.sql`

Together they default new profiles to inactive viewers, protect the final active
administrator, enable RLS across all public base tables, reset grants and default
grants, install active-role policies, route staff through redacted inventory,
movement, recipe and stock-count views, and keep direct commercial tables
manager-only.

The runtime correction removes an invalid `recipe_ingredients.created_at`
reference discovered by the transactional role acceptance. The canonical
`recipe_ingredients` table has no such column, so the redacted recipe projection
now orders deterministically by ingredient id.

`public.public_menu` is the deliberate exception. It exposes exactly `id`,
`name`, `type` and `menu_price` to anonymous visitors.

Production application is intentionally paused.

## Authentication and email-delivery gates

Owner-confirmed in the production Supabase dashboard:

- [x] Email signup disabled.
- [x] Email confirmation enabled.
- [x] Leaked-password protection enabled.
- [x] Minimum password length is at least 10.
- [x] Custom SMTP configured.
- [ ] Invitation and password-reset delivery confirmed through the custom SMTP provider.
- [ ] JWT expiry and Auth rate limits reviewed and recorded.

The owner also confirmed that the staff invitations were completed. The
production database currently reports **3 Auth users and 3 active profiles**
(two admins and one manager), with no pending or unprofiled users. Before
production migration, reconcile whether three is the intended current team or
whether two invitations are still missing. Do not record the five-account gate
as verified until this discrepancy is resolved.

Still required outside the repository:

- [ ] 2FA enabled on Supabase, GitHub and Netlify.
- [ ] GitHub Secret scanning and Push protection enabled.
- [ ] Netlify environment variables and build hooks reviewed.

## Preview role acceptance

`scripts/verify_phase1_role_matrix_preview.sql` is preview-only, requires an
empty isolated branch, creates disposable Auth and business fixtures inside one
transaction, and rolls everything back.

The latest run passed **18 of 18** checks:

- logged-out `public_menu` access allowed;
- anonymous inventory access denied;
- active bartender recognized as staff but not manager;
- bartender reads redacted inventory, recipe and stock-count projections;
- bartender cannot see canonical cost-bearing inventory rows;
- bartender direct update and delete policies reach zero rows;
- active admin reads commercial inventory, supplier, recipe and manager count evidence;
- inactive and unlisted authenticated users receive no inventory rows.

The acceptance fixture was fully rolled back. The isolated preview branch still
contains zero Auth users, zero profiles, zero inventory rows and zero movement
rows.

## Back up before production

Save outside the public repository:

1. schema-only database dump;
2. exports of every affected table;
3. migration ledger;
4. policy and grant inventory;
5. public view definitions;
6. deployed commit SHA;
7. current role/profile list;
8. output of `scripts/verify_phase1_security_gate.sql`.

Expected pre-migration production fingerprint:

- inventory records: 49
- active inventory records: 49
- summed quantity: 131.2
- inventory movements: 12

## Production order

1. Reconcile the production staff-account count.
2. Confirm SMTP invitation and password-reset delivery.
3. Confirm JWT/rate-limit review, 2FA, GitHub security settings and Netlify review.
4. Verify `imadelmoubarik4@gmail.com` is active `admin`.
5. Create the off-repository backups above.
6. Apply `20260806104705_atlas_phase1_profiles_security_gate.sql`.
7. Apply `20260806105543_atlas_phase1_recipe_catalog_gate.sql`.
8. Apply `20260806151244_atlas_phase1_recipe_catalog_runtime_fix.sql`.
9. Run `scripts/verify_phase1_security_gate.sql`.
10. Deploy the browser and Netlify hardening commit.
11. Run the production browser role matrix below.
12. Re-run the fingerprint and compare it with the baseline.
13. Keep PR #5 draft until every result is recorded.

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
| Bartender directly changes live quantity | Denied |
| Bartender changes cost or deletes an item | Denied |
| Manager reads commercial fields | Allowed |
| Manager publishes an approved count | Controlled L1 publication only |
| Browser calls private L1/L2 tables | Denied |
| Preview publication | Blocked |
| L2 publication changes quantity or creates a movement | Never |

## Rollback

Do not restore the old permissive policies as an emergency shortcut. Roll back
the web deployment first, then restore the pre-migration schema/policy snapshot
inside a maintenance window. The database migration is deliberately designed to
fail before changing policy if no active administrator exists.
