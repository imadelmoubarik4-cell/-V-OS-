# ALCEDO — Employee Management: Gap Audit & Implementation Proposal

**Date:** 2026-10-18 · **Status:** audit + proposal (no code). Build on the existing Team module; do not duplicate it.

## How it works today
- **Identity** in production `public.profiles` (id, email, display_name, role, active) + onboarding tables.
- **Employment detail** in `atlas_private.team_profile_details` (job_title, department, employment_type, start_date, manager_notes) + emergency contacts.
- **Roster** in `atlas_private.shift_people` — supports **schedule-only people** (`source='manual'`, `profile_id=NULL`, `login_enabled=false`), i.e. you can schedule someone without a login today.
- **Gateway:** `supabase/functions/atlas-team-profiles/index.ts` is the authorization boundary; the browser (`team-profiles.source.js`) holds no table access.

## Capability status
| Capability | Status | Evidence / gap |
|---|---|---|
| Add — schedule-only (no login) | **EXISTS** | `atlas_shifts_create_person`, manager-only |
| Add — login member w/ invite | **EXISTS** | `create-login-member` (invite link), manager + step-up, email dedupe 409 |
| Job title / department / employment type / start date | **EXISTS** (fields) | `team_profile_details`; but **not** collected at Add (create passes nulls) — wiring only |
| **Business location assignment** | **MISSING** | no location column anywhere — depends on the multi-tenant `locations` model |
| Edit employee | **EXISTS** | `save-details` (manager fields vs self fields enforced in SQL) |
| Deactivate / Reactivate | **EXISTS (robust)** | `update-access`: `active`+role, step-up, **self-guard**, **last-admin/manager guard**, real **session revocation** (s96 trigger), audit event |
| Invitation create / send / resend | **EXISTS** | `invite-account`, `renew-member-setup` |
| Invitation state pending/accepted/expired | **MISSING (surfaced)** | only implicit via auth `email_confirmed_at`/`app_metadata`; not shown to managers |
| Remove-from-location | **MISSING** | no location membership concept yet |
| **Permanent deletion (server-side)** | **MISSING (by design)** | no `auth.admin.deleteUser` anywhere; deactivate is the only off-boarding path |
| Role model + MFA/AAL2 + step-up | **EXISTS (strong)** | `requireManager`+`requireStepUp`; privileged AAL2 |
| Duplicate prevention | **PARTIAL** | login path guarded; `invite-account` relies on Supabase 422 only; manual roster w/o email can duplicate |

## Retention map for a deletion workflow (what may be erased vs must be kept)
- `profiles.id → auth.users` **ON DELETE CASCADE** (deleting the auth user cascades profile + sessions).
- `inventory_movements.created_by` / `recipes.updated_by` / `import_batches.created_by` → **ON DELETE SET NULL** (rows survive, actor anonymized — correct).
- `shift_entries.person_id → shift_people` **ON DELETE RESTRICT** (a rostered person with shifts cannot be hard-deleted until detached).
- Audit tables are **append-only** (s96; break-glass only for legally-required erasure).
- Finance/decision/message ledgers store a **text actor_label** (display name, never email), so attribution survives deletion.
- Profile **photo** removal exists (`atlas_team_profile_photo_remove` + storage delete); **MFA factor** removal exists (`reset-member-mfa`).

## Proposed implementation (risk-tiered)
### LOW risk (additive; no auth/deletion surface) — candidate for an early PR
1. **Surface invitation state** — add a computed `invitation_status` (pending/accepted/expired) to the team snapshot, derived read-only from auth (`atlas_invited_by` + `email_confirmed_at` + age vs expiry); render as a pill. Optional: persist `invited_at`/`accepted_at`.
2. **Employment detail at Add** — pass department/employment_type/start_date into the existing `atlas_team_profile_upsert_details` (fields already exist; create currently nulls them). Pure wiring.
3. **Invite duplicate guard** — apply the same pre-check `create-login-member` uses before `invite-account`, plus roster/email reconciliation. Fail-closed validation.
4. **Reactivate UX** — server already supports it; ensure the inactive filter + a clear reactivate affordance are surfaced.

### MEDIUM
5. **Deactivate/Reactivate** — no backend change needed; session revocation + last-admin guards already enforce correctness.

### HIGH risk (auth + data deletion — APPROVAL REQUIRED, design-first, do not build casually)
6. **Permanent deletion** — must be a new admin-only, step-up + AAL2 gated workflow that:
   - **Anonymize-first** (default): deactivate (sessions already revoked), scrub PII in `team_profile_details`/emergency contacts, delete the profile **photo** and **MFA factors** (reuse existing RPCs), write an **immutable** audit event — leaving attribution rows intact.
   - **True auth-user erasure** (GDPR) only via `auth.admin.deleteUser`, relying on the FK design (profile cascades; `created_by/updated_by` SET NULL preserves anonymized finance/inventory/recipe history; append-only audit break-glass is the only sanctioned erasure path). Preserve payroll/finance/decision ledgers (text actor_label survives).
   - **Hard guards:** never the last active admin (existing `preserve_active_admin` trigger + race lock), never the last active manager, **never your own admin account**; `shift_entries` RESTRICT blocks deleting a rostered person with shifts (detach/retain first).
   - UX: explain what is erased vs retained; require typing the employee's name; require recent MFA; record the admin action without storing unnecessary PII.
7. **Business location assignment / Remove-from-location** — depends on the multi-tenant `locations` + `memberships` model (see `ALCEDO_MULTI_TENANCY_ARCHITECTURE.md`); build after the tenant foundation lands. "Remove from location" = drop a membership (reversible), distinct from deletion.

## Acceptance target
A KANEL admin adds an employee, sends an invitation, assigns a role, edits details, deactivates access, and permanently deletes an eligible employee — on desktop and mobile — without a developer or manual Supabase. The LOW-risk items get most of the "add/invite/edit/state/reactivate" UX there quickly; the location and permanent-deletion pieces are the approval-gated, higher-risk remainder.

## Sequencing
LOW-risk items (1–4) can ship as a focused, tested PR independent of multi-tenancy. Permanent deletion (6) needs a reviewed design + your approval before implementation. Location membership (7) follows the tenant foundation. None of this is in the cleanup PR.
