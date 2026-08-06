# Phase 1 Security Gate — preview closure record

## Status

The Phase 1 security gate is implemented and validated on the isolated Atlas
preview branch. It is **not applied to production**. Production authorization
still requires off-repository backups and the remaining dashboard evidence
listed below.

PR #5 remains draft, unmerged and unauthorized for production migration.

## Canonical authorization decision

- `public.profiles` is the only staff authorization registry.
- The business owner maps to the existing `admin` role.
- `manager` and `bartender` remain operational roles.
- `viewer` is retained as read-only compatibility.
- `public.staff` must not coexist with `public.profiles`.
- New Auth users receive an inactive `viewer` profile until an administrator
  explicitly approves and activates them.
- The final active administrator is protected from accidental deletion,
  demotion or deactivation.

## Preview database migrations

The isolated Atlas Supabase branch contains and has applied:

- `20260806104705_atlas_phase1_profiles_security_gate.sql`
- `20260806105543_atlas_phase1_recipe_catalog_gate.sql`
- `20260806151244_atlas_phase1_recipe_catalog_runtime_fix.sql`

The runtime correction was required after transactional acceptance found that
the redacted recipe function ordered ingredients by a nonexistent
`recipe_ingredients.created_at` column. It now orders by `ingredient.id`, and a
regression contract prevents the invalid reference from returning.

The preview verification confirmed:

- every public base table has RLS enabled;
- legacy overlapping policies and browser grants were replaced by one canonical
  active-profile policy model;
- default privileges no longer grant future public-schema tables or functions
  to browser roles automatically;
- anonymous users retain only the deliberate `public_menu` projection;
- `public_menu` exposes exactly `id`, `name`, `type` and `menu_price`;
- supplier, inventory-cost, recipe-cost, import-review and commercial source
  tables are manager/admin-only;
- active staff use redacted inventory, movement, recipe and stock-count views;
- `stock_count_summary` omits verifier identity, variance, supplier and cost;
- `stock_count_manager_summary` is manager-gated and preserves verification
  provenance;
- the authenticated inventory adjustment RPC is manager/admin-only and always
  records an immutable movement;
- browser-provided inventory and recipe audit identities are no longer trusted.

## Preview role acceptance

The versioned preview-only script
`scripts/verify_phase1_role_matrix_preview.sql` passed **18 of 18** checks in one
rollback-only transaction:

- logged-out menu access allowed;
- anonymous inventory access denied;
- active bartender recognized as staff but not manager;
- bartender receives redacted inventory, recipe and stock-count data;
- bartender receives no canonical cost-bearing inventory rows;
- bartender direct update and delete policies reach zero rows;
- admin receives commercial inventory, supplier, recipe and manager count evidence;
- inactive and unlisted authenticated users receive no inventory rows.

The disposable fixture was fully rolled back. After acceptance, the isolated
branch still had zero Auth users, zero profiles, zero inventory rows, zero summed
quantity and zero movements.

## Preview web hardening

The preview branch includes:

- active-profile verification before opening the operational application;
- role-aware commercial navigation and controls;
- staff reads through redacted catalogue relations;
- manager-gating for scanner live application;
- role-redacted stock-count production-source payloads;
- Supabase JS `2.45.4`, Lucide `0.454.0` and XLSX `0.18.5` pinned with the
  reviewed SRI hashes;
- HSTS, CSP and Permissions Policy headers;
- `camera=(self)` for the barcode workflow;
- CSP connectivity for both approved Supabase projects;
- the punycode VÁ domain in `frame-ancestors`;
- CI contracts for RLS, grants, views, RPC boundaries, CDN pinning, SRI,
  credentials and production-mutation safety.

## Authentication evidence

Owner-confirmed in the production Supabase dashboard:

- public Email signup disabled;
- email confirmation enabled;
- leaked-password protection enabled;
- minimum password length set to at least 10;
- custom SMTP configured;
- staff invitations reported as completed.

The production database currently reports **3 Auth users and 3 active profiles**
(two admins and one manager), with no pending or unprofiled accounts. This does
not match the earlier five-account completion target. The production migration
remains paused until the owner confirms that three is now the intended team or
invites the two missing accounts.

SMTP configuration is recorded, but invitation and password-reset delivery must
still be demonstrated through the custom provider.

## Production safety evidence

No Phase 1 migration was executed against production. The production inventory
fingerprint remains the release baseline:

- inventory records: **49**
- active inventory records: **49**
- summed recorded quantity: **131.2**
- inventory movements: **12**

A rollback/safety branch exists at:

` safety/pr5-before-phase1-security-gate-20260806 `

## Manual gates still required

Before production SQL or merge authorization, record evidence that:

- the production staff-account count is reconciled;
- an invitation and password-reset email are delivered through custom SMTP;
- JWT expiry and Auth rate limits were reviewed;
- 2FA is enabled for Supabase, GitHub and Netlify;
- GitHub Secret scanning and Push protection are enabled;
- Netlify environment variables and build-hook URLs were reviewed;
- schema, affected-table data, migrations, policies, grants and view definitions
  were backed up outside the public repository;
- the production browser role matrix passes after migration.

Until these items are complete, L2 stays preview-only and no production
publication or security migration is authorized.
