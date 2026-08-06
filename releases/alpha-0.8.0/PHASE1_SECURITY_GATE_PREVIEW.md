# Phase 1 Security Gate — preview closure record

## Status

The Phase 1 security gate and production-compatible migration split are
implemented and transactionally accepted on the isolated Atlas preview. They are
**not applied to production**. PR #5 remains draft, unmerged and unauthorized for
production migration.

## Canonical authorization decision

- `public.profiles` is the only staff authorization registry.
- The business owner maps to `admin`.
- `manager` and `bartender` remain operational roles.
- `viewer` is retained as read-only compatibility.
- `public.staff` must not coexist.
- New Auth users receive an inactive `viewer` profile until an administrator
  explicitly approves and activates them.
- The final active administrator is protected from accidental deletion,
  demotion or deactivation.

## Production-compatible split

The executable production migration
`20260806104705_atlas_phase1_profiles_security_gate.sql` no longer references
`atlas_private` and creates no local stock-count evidence view.

The exact version previously applied to preview is archived at:

`docs/security/preview-applied/20260806104705_atlas_phase1_profiles_security_gate.preview.sql`

The Atlas-only evidence views are now owned by:

`20260806165146_atlas_phase1_stock_count_views_branch_only.sql`

That migration is guarded by the presence of
`atlas_private.inventory_verified_balances`. It creates the redacted staff and
manager views on Atlas, and performs an intentional no-op in production.

## Transactional acceptance

The latest acceptance established:

- **18 of 18** preview role checks passed and rolled back;
- the exact production-safe security migration executed successfully in a
  rollback-only transaction;
- the guarded stock-view migration created no views when the Atlas source schema
  was hidden to simulate production;
- preview verification found no table without RLS, unsafe non-public view or
  unintended browser function exposure;
- `public_menu` retained exactly four approved columns and anonymous `SELECT`;
- bartender access remained redacted and commercial tables remained hidden;
- admin commercial access remained available;
- inactive and unlisted authenticated users received no inventory rows;
- preview remained empty after all fixtures and dry runs were rolled back.

## Production schema preflight

The read-only production preflight passed:

- every required production table and column used by Phase 1 exists;
- `public.profiles` exists and `public.staff` does not;
- the role enum contains `admin`, `manager`, `bartender` and `viewer`;
- two active administrators exist;
- `auth.uid()` is available;
- `atlas_private` is absent as expected;
- no Phase 1 migration has been applied to production.

Production remained unchanged:

- inventory records: **49**
- active inventory records: **49**
- summed recorded quantity: **131.2**
- inventory movements: **12**

## Authentication evidence

Owner-confirmed:

- public Email signup disabled;
- email confirmation enabled;
- leaked-password protection enabled;
- minimum password length at least 10;
- custom SMTP configured;
- three current accounts are intentional;
- two future staff accounts will be invited later through an administrator-only
  server-side Atlas workflow.

SMTP invitation and password-reset delivery still require acceptance evidence.

## Backup evidence

The encrypted off-repository logical backup and rollback package has been
created. It includes business data, sanitized Auth metadata, schema and security
metadata, migrations, fingerprints, rollback SQL and a restore generator. The
archive and its encryption key must remain in separate secure locations.

## Remaining release gates

- confirm SMTP invitation and reset delivery;
- review JWT expiry and Auth rate limits;
- enable/confirm 2FA on Supabase, GitHub and Netlify;
- enable/confirm GitHub Secret scanning and Push protection;
- confirm the branch ruleset is active;
- review Netlify environment variables and build-hook URLs;
- delete the temporary JWT-gated, 410-only backup Edge Function;
- resolve the Supabase branch control-plane `MIGRATIONS_FAILED` label;
- take a fresh final backup immediately before production migration;
- run production browser role acceptance after migration;
- confirm the post-migration fingerprint.

Until these gates pass, L2 remains preview-only and no production publication,
security migration or merge is authorized.
