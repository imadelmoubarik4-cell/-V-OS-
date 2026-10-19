# ALCEDO — Permanent Employee Deletion: Design & Security Review

**Date:** 2026-10-18 · **Status:** DESIGN ONLY — no implementation, **no production deletion**. Requires explicit approval + a security review sign-off before any build.

Goal: an authorized administrator can permanently delete an *eligible* employee directly in Alcedo, erasing eligible personal data while **preserving legally/operationally required business records** and protecting production integrity.

## Two-mode model
1. **Anonymize-and-offboard (default, lower risk).** Keep the row identity for referential integrity but strip personal data; revoke access. Reversible-ish (the person can be re-invited as a new account).
2. **Full erasure (GDPR, higher risk).** Delete the auth user; rely on the existing FK design so business rows survive anonymized. Used only when erasure is legally required/requested and the person is eligible.

The UI presents mode (1) as the normal off-boarding and mode (2) behind an explicit "permanently delete / erase personal data" confirmation.

## Eligibility gate (checked server-side before anything is deleted)
A profile is eligible for **full erasure** only if ALL hold:
- Caller is `admin` (not manager), with **recent step-up** (`requireStepUp`) and **AAL2** MFA.
- Target is **not the caller** (no self-deletion — extends the existing self-guard).
- Target is **not the last active admin** and not the last active manager (existing `preserve_active_admin` trigger + `s96_last_admin_race` lock + the manager guard in `update-access`).
- Target has **no blocking operational references** that must not be detached (see retention map). Where `ON DELETE RESTRICT` applies (`shift_entries.person_id → shift_people`), those must be reconciled first or the delete is refused with an explanation.
- Target has **no other authorized org/location membership** (relevant once multi-tenancy lands — don't delete the auth user if they still belong to another business).

If ineligible, the workflow **refuses and explains why**, offering the alternative (deactivate, or remove-from-location) instead.

## Server-side workflow (new admin-only gateway action; NOT built yet)
Mirrors the user's 10-point requirement:
1. **Explain** up front what is erased vs retained (see tables below).
2. **Authorize:** `admin` + `requireStepUp` + AAL2.
3. **Confirm:** require typing the employee's exact display name in the request; server re-checks it against the profile.
4. **Revoke access:** set `active=false` first — the existing `revoke_sessions_on_access_loss` trigger deletes `auth.sessions`/refresh tokens; every gateway re-checks the live profile, so access dies immediately.
5. **Remove location memberships** (multi-tenant phase): drop `memberships` rows (reversible unit distinct from deletion).
6. **Delete the auth account** only when eligible and no other org membership: `admin.auth.admin.deleteUser(id)`. `profiles.id → auth.users ON DELETE CASCADE` removes the profile + sessions.
7. **Remove eligible personal data:** profile photo (reuse `atlas_team_profile_photo_remove` + storage delete), MFA factors (reuse `reset-member-mfa` logic), `team_profile_details` PII, emergency contacts.
8. **Anonymize linked personal info:** `inventory_movements.created_by` / `recipes.updated_by` / `import_batches.created_by` are `ON DELETE SET NULL` — actor becomes null automatically; no row is lost.
9. **Preserve required records:** payroll/finance/decision ledgers and immutable audit are **retained**; they already store a *text* `actor_label` (display name, never email), so prior actions stay attributable without re-identifying a deleted person. Minimize any residual personal data.
10. **Record the admin action** in the immutable audit (`team_profile_events`) with who/when/what-erased — **without** storing unnecessary sensitive PII of the deleted person.

## Retention map (what is erased vs kept)
| Data | Action on erasure | Mechanism |
|---|---|---|
| Auth user, profile row, sessions | **Erased** | `profiles.id → auth.users ON DELETE CASCADE` |
| Profile photo, MFA factors, emergency contacts, `team_profile_details` PII | **Erased** | existing photo/MFA RPCs + targeted deletes |
| Inventory movements / recipe edits / import batches authored | **Kept, anonymized** | `created_by`/`updated_by` `ON DELETE SET NULL` |
| Finance / accounting / decision ledgers, messages | **Kept** (text `actor_label` retained) | immutable by design; append-only audit |
| Shift history with hard references | **Blocks erasure until reconciled** | `shift_entries.person_id ON DELETE RESTRICT` |
| Immutable audit trail | **Kept** (append-only) | `s96_audit_append_only`; break-glass only for legally-required erasure |

## Hard guards (must all be enforced server-side)
- Never delete your **own** admin account through this workflow.
- Never delete the **last active admin** or **last active manager**.
- Admin-only + recent MFA/step-up on every call.
- Name-match confirmation re-verified server-side (not trusted from the client).
- Refuse (don't silently skip) when retention/RESTRICT/other-membership blocks erasure; return the reason + the safe alternative.
- Never delete shifts, financial totals, stock transactions, inventory adjustments, or messages belonging to other people as a side effect.

## Security review checklist (to complete before build sign-off)
- [ ] Privilege: confirm only `admin` + AAL2 + step-up reaches the action; manager/bartender/viewer get 403.
- [ ] CSRF/replay: the action is POST through the authenticated gateway; name-match + step-up window limit misuse.
- [ ] Idempotency & partial failure: if auth-user delete succeeds but a later step fails, the record must not be left half-erased with access restored — order operations so access revocation is first and irreversible-after-confirm; make each sub-step retriable.
- [ ] Audit completeness: the deletion event is written **before** the cascade (so it survives) and contains no excess PII.
- [ ] Break-glass: the append-only audit erasure path is used only under the documented legal-erasure flag, logged.
- [ ] Tenancy (future): never erase the auth user while another org membership exists.
- [ ] Tests: role matrix (each role), self-delete blocked, last-admin/last-manager blocked, RESTRICT-blocked case returns the reason, anonymization leaves business rows intact, audit written, sessions revoked.

## Test plan (when built)
Node/handler + browser: admin can erase an eligible member; manager/bartender cannot; self-delete refused; last-admin refused; a member with shift history is refused with the explanation; after erasure the auth user is gone, photo/MFA removed, `created_by` rows anonymized, finance/audit preserved, sessions revoked; the audit event exists.

## Recommendation
Build **mode (1) anonymize-and-offboard** first (lower risk, no auth-user deletion) as an incremental step after the current Employee Management PR, then design-review and build **mode (2) full erasure** separately with the checklist above signed off. No production deletion occurs until you approve, and the first production run should be rehearsed on a disposable account.
