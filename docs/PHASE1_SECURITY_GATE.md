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

Together they default new profiles to inactive viewers, protect the final active
administrator, enable RLS across all public base tables, reset grants and default
grants, install active-role policies, route staff through redacted inventory,
movement, recipe and stock-count views, and keep direct commercial tables
manager-only.

`public.public_menu` is the deliberate exception. It exposes exactly `id`,
`name`, `type` and `menu_price` to anonymous visitors.

Production application is intentionally paused.

## Manual authentication gates — required before production SQL

Record evidence for each item:

- [ ] Supabase Email signup disabled.
- [ ] Email confirmation enabled.
- [ ] Five staff invited manually.
- [ ] Leaked-password protection enabled.
- [ ] Minimum password length is at least 10.
- [ ] JWT expiry and Auth rate limits reviewed.
- [ ] 2FA enabled on Supabase, GitHub and Netlify.
- [ ] GitHub Secret scanning and Push protection enabled.
- [ ] Netlify environment variables and build hooks reviewed.

Do not apply the production migration until these are checked.

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
- summed quantity: 131.2
- inventory movements: 12

## Production order

1. Confirm all manual authentication gates.
2. Verify `imadelmoubarik4@gmail.com` is active `admin`.
3. Create the backups above.
4. Apply `20260806104705_atlas_phase1_profiles_security_gate.sql`.
5. Apply `20260806105543_atlas_phase1_recipe_catalog_gate.sql`.
6. Run `scripts/verify_phase1_security_gate.sql`.
7. Deploy the browser and Netlify hardening commit.
8. Run the role matrix below.
9. Re-run the fingerprint and compare it with the baseline.
10. Keep PR #5 draft until every result is recorded.

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
