# Phase 1 Security Gate — preview closure record

## Status

The Phase 1 security gate is implemented and validated on the isolated Atlas
preview branch. It is **not applied to production**. Production authorization
requires completion of the manual dashboard gates, off-repository backups and
the role-based acceptance matrix in `docs/PHASE1_SECURITY_GATE.md`.

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

## Preview web hardening

The preview branch now includes:

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

- Supabase public Email signup is disabled;
- email confirmation remains enabled;
- the five staff accounts were invited manually;
- leaked-password protection is enabled;
- minimum password length is at least 10;
- JWT expiry and Auth rate limits were reviewed;
- 2FA is enabled for Supabase, GitHub and Netlify;
- GitHub Secret scanning and Push protection are enabled;
- Netlify environment variables and build-hook URLs were reviewed;
- schema, affected-table data, migrations, policies, grants and view definitions
  were backed up outside the public repository;
- the administrator, bartender and logged-out acceptance matrix passed.

Until these items are complete, L2 stays preview-only and no production
publication or security migration is authorized.
