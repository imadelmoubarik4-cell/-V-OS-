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
- New Auth users receive an inactive `viewer` profile until administrator
  approval.
- The final active administrator is protected.

## Migration split and lint closure

- production foundation:
  `20260806104705_atlas_phase1_profiles_security_gate.sql`;
- Atlas-only stock views:
  `20260806165146_atlas_phase1_stock_count_views_branch_only.sql`;
- security-lint closure:
  `20260806171317_atlas_phase1_public_menu_and_adjustment_lint_fix.sql`.

The public menu now uses a security-invoker view over a trigger-maintained,
column-limited projection in the non-exposed `public_menu_private` schema. The
public page creates a fresh anonymous client and requests only the four public
fields. `adjust_inventory` is security-invoker and can insert a movement only
through the active manager/admin policy.

## Acceptance evidence

- preview role matrix: **20 passed, 0 failed, rolled back**;
- exact production-safe migration: passed in rollback-only transaction;
- production-topology stock-view no-op: passed;
- Supabase security advisors: **zero findings**;
- tables without RLS: none;
- unsafe non-public views: none;
- unintended browser functions: none;
- `security_lint_blockers`: none;
- bartender controlled adjustment: denied;
- manager controlled adjustment: quantity and movement evidence passed inside
  the rollback-only fixture;
- logged-out public menu: passed;
- inactive and unlisted users: denied;
- preview fixtures after testing: zero.

## Production preflight and fingerprint

Read-only production preflight passed: required columns exist, profiles is
canonical, staff and `atlas_private` are absent, roles are complete, two active
admins exist and no Phase 1 migration is applied.

Production remained unchanged:

- inventory records: **49**;
- active records: **49**;
- quantity: **131.2**;
- movements: **12**.

## Authentication and backup evidence

Owner-confirmed: signup disabled, email confirmation enabled, leaked-password
protection enabled, minimum length 10+, custom SMTP configured, three current
accounts intentional and two later invitations reserved for the admin-only app
workflow.

The encrypted off-repository backup and rollback package exists. Archive and key
must stay in separate secure locations.

## Remaining release gates

- confirm SMTP invitation and password-reset delivery;
- review JWT expiry and Auth rate limits;
- confirm 2FA on Supabase, GitHub and Netlify;
- confirm GitHub Secret scanning, Push protection and branch ruleset;
- review Netlify environment variables and build hooks;
- manually delete the temporary JWT-gated, 410-only backup Edge Function;
- resolve the stale Supabase branch `MIGRATIONS_FAILED` control-plane label;
- obtain a final green repository CI run at the release head;
- take a fresh backup immediately before production migration;
- run production browser role acceptance and fingerprint verification.

Until these gates pass, L2 remains preview-only and no production publication,
security migration or merge is authorized.
