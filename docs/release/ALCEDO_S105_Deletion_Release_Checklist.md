# ALCEDO S105 — Delete Team Member: controlled deployment checklist

Scope: ship the Team → profile **Remove from team** (reversible archive) and
**Delete permanently** (real deletion) feature in `app.alcedo.is`. Nothing in
this checklist has been executed against production; every production step below
is an owner action and is listed so it can be done deliberately and in order.

Branch `claude/employee-deletion` · PR #129 (draft). Production/branch Supabase
project `dnefgcmjcgxlynycxkts`. New migration `20261022090000_s105_team_member_deletion.sql`.
Edge function `atlas-team-profiles`.

---

## 0. Preconditions / gates (must be green before anything ships)

- [ ] PR #129 CI: **`replay`** green and **`contracts`** green. `contracts` was
      red only because the reviewed-source fingerprint of
      `supabase/functions/atlas-team-profiles/index.ts` changed; it was re-pinned
      through its chain (see §6) and the Python contract suite passes.
- [ ] `Browser tests` and `disposable PostgreSQL 17` are **non-required** checks.
      Their red is pre-existing and not caused by this PR (see §6); confirm they
      are no worse than on `main` and merge on the required gates.
- [ ] Code review of PR #129 complete and approved by the owner.

## 1. PR #128 / #129 dependency and conflict review

PR #128 (Employee Management, draft) and PR #129 (this) both modify the same five
files, so they **cannot both fast-merge**:

- `apps/web/assets/js/team-profiles.source.js` + `…/team-profiles.bundle.js.gz` (binary — always conflicts)
- `supabase/functions/atlas-team-profiles/index.ts` (also carries the pinned fingerprint)
- `tests/browser/people-fixtures.mjs`, `tests/browser/team.browser.test.mjs`

Plan (merge **#129 first** — the owner's priority):
- [ ] Merge **PR #129** to `main` first. It is conflict-free against `main` today
      (mergeable), gated green on `contracts` + `replay`.
- [ ] Afterwards, rebase **PR #128** onto the new `main`; resolve the overlap in
      `index.ts`, `team-profiles.source.js`, the two test files **by hand**.
- [ ] On #128, rebuild the gzip bundle: `node scripts/build_team_profiles_bundle.mjs`
      (never resolve the `.gz` by hand) and confirm with `--check`.
- [ ] Re-pin the `atlas-team-profiles/index.ts` fingerprint chain on #128 (see §6) —
      the merged `index.ts` is a new byte sequence.
- [ ] Re-run node + browser + the s105 SQL verifier on the rebased #128.

## 2. S104 migration-ledger status (independent, do not block S105)

- [ ] S104 (KANEL pricing) schema is fully applied and live in production; the
      only outstanding item is the **ledger row `20261021090000`** missing from
      `supabase_migrations.schema_migrations` (tracked as issue #124). It is a
      single idempotent INSERT, blocked by the production-write guard — an owner
      action, unrelated to S105. S105 does not depend on it.

## 3. S105 isolated migration verification (done; re-run after any rebase)

- [x] Full migration replay including s105 applies cleanly in a disposable
      Postgres (`scripts/verify_full_migration_replay.sh`).
- [x] DB-boundary acceptance passes (`scripts/verify_s105_team_deletion.sh` →
      `tests/sql/s105_team_member_deletion.sql`): wrappers service_role-only and
      anon denied at runtime; audit RLS-on and append-only; worked-shift
      RESTRICT→anonymize with the shift kept; no-shift hard delete with
      availability/time-off/responses cascading and events SET NULL; schedule-only
      route refuses a login-linked row; exactly-one-identifier; unknown target
      refused; permanent-deletion audit name-redacted; remove-from-team reversible.
- [ ] Re-run both after the §1 rebase.

## 4. Server-side MFA enforcement (confirm env before/at deploy)

Permanent deletion is gated **server-side** in `deleteMember` via
`requireFreshMfaForDeletion`: administrator role + an enrolled verified second
factor + an `aal2` session + a **recent** second-factor check. A password-only
reauthentication never satisfies it, and this holds **regardless of**
`ATLAS_REQUIRE_STEP_UP`.

- [ ] `atlas-team-profiles` has `SUPABASE_URL` = the production project URL and a
      valid `SUPABASE_SERVICE_ROLE_KEY` (needed for the Auth-user deletion and the
      storage object removal). The service-role key is **never** sent to the browser.
- [ ] Optional: `ATLAS_STEP_UP_MAX_AGE_SECONDS` (default 900, capped 3600) sets the
      recency window for the fresh-MFA check.
- [ ] Confirm every administrator who will use permanent deletion has an
      authenticator enrolled (otherwise the action fails closed with
      `mfa_enrollment_required` — by design).

## 5. Apply the migration + deploy the edge function (production)

**Reviewed order — do NOT run a directory-wide `supabase db push`** while S104's
ledger row is missing (§2), or it will replay S104. Use the explicit sequence
(rehearsed by `scripts/apply_s105_reviewed.sh` on a disposable DB; the owner runs
the same four statements in production):
- [ ] **1. Backfill the S104 ledger row first** (idempotent), so S104 is never
      replayed:
      `insert into supabase_migrations.schema_migrations(version,name,statements)
      values ('20261021090000','s104_kanel_pricing',array[]::text[]) on conflict (version) do nothing;`
- [ ] **2. Apply ONLY** `supabase/migrations/20261022090000_s105_team_member_deletion.sql`
      (idempotent / re-runnable) — not a push.
- [ ] **3. Record the S105 ledger row** (idempotent), version `20261022090000`.
- [ ] **4. Verify the ledger**: `scripts/verify_migration_ledger.sh` (no pending
      migrations; S104 and S105 recorded).
- [ ] Deploy the `atlas-team-profiles` edge function.
- [ ] Deploy the frontend (the Team bundle) — Netlify builds from `main` on merge.
- [ ] Smoke check: load Team, open a profile, confirm **Remove from team** (manager+)
      and **Delete permanently** (admin only) appear and are hidden on your own row.

## 6. CI fingerprint re-pin (what changed and why)

`atlas-team-profiles/index.ts` is a reviewed source pinned in a fingerprint
chain. The legitimate S105 edit changed its hash, so the pins were updated (the
repo's standard re-pin procedure, not a blind replace — only this one file and
its dependents were touched):
- `tests/fixtures/s33-runtime-artifact.json` — `source_sha256` + `candidate_sha256`.
- `docs/release/Atlas_S35_Combined_Isolated_Staging_Manifest.json` — the index.ts source hash.
- `docs/release/Atlas_S39_Production_Launch_Manifest.json` and
  `docs/release/Atlas_S41_Production_Function_Addendum.json` — the S35-manifest file hash
  they reference (`source_manifest_sha256` / `base_source_manifest_sha256`).

Known pre-existing reds (NOT introduced by S105, do not block the required gates):
- `disposable PostgreSQL 17` fails on a Phase-1 adoption security-lint
  (`adjust_inventory is not a caller-evaluated manager-only RPC`). That run applies
  only the baseline + Phase-1 adoption migrations — it does not apply s105 — so it
  is unchanged by this PR and is a separate inventory-RPC workstream.
- `Browser tests` carries the known atlas-bot WebGL flake in CI's GPU-less runner,
  and a Reports tab-indicator layout check (ux-acceptance-r2 N-9) that differs by
  1px of subpixel rendering in that runner. Verified **not a regression**: this PR
  changes only `team-profiles.*` (no Reports, shared-layout, or tab-indicator
  code), and N-9 passes locally in headless Chromium. Documented, not weakened.

## 7. Synthetic employee deletion test (pre-production rehearsal)

On an **isolated** Supabase-compatible project (never real staff), with the
edge function deployed and MFA configured:
- [ ] Create synthetic accounts: a login member with no shifts, a login member
      with past shifts, and a schedule-only roster person.
- [ ] Permanent delete each; confirm: the no-shift member is fully gone (auth user
      deleted, details/contacts/photo removed); the with-shift member is anonymized
      to "Former team member" with the shift kept; the schedule-only person is
      removed; the audit row carries no name.
- [ ] Confirm the guards: self-delete blocked, last-admin blocked, wrong typed
      name blocked, no authenticator → blocked, schedule route on a login-linked
      person → blocked.
- [ ] Confirm **Remove from team** archives reversibly (member reappears under the
      Inactive filter, record intact) and can be re-added.

## 8. Rollback and partial-failure recovery

**Partial outcomes are reported truthfully by the feature (never a false success),
and every recovery runs inside Alcedo — no manual Supabase access:**
- Auth-user delete failed → `{ ok:false, partial:true, auth_deleted:false }` with a
  "safe to retry" message. Recovery: **re-run Delete permanently** for the same
  member in Alcedo. The branch purge is now idempotent (the login route treats an
  already-cleaned target as a valid no-op, `already_clean:true`), so the retry
  skips the completed cleanup, performs no duplicate destructive op, keeps every
  shift, and finishes the Auth-user deletion. Proven by `tests/sql` check 7 and the
  node "resumed delete" test.
- Profile-photo object removal failed → `{ ok:false, partial:true,
  storage_cleanup_required:true, storage_path:<path> }`, and the path is recorded
  in `atlas_private.team_member_deletion_orphans`. Recovery: admins see a **Team
  banner** ("N leftover profile photos to remove — Finish cleanup") that calls
  `cleanup-photo-orphans` (admin + step-up) to remove the objects and mark them
  resolved. No manual Supabase access, no asking Claude. The count rides the
  snapshot (`staff.photo_orphan_count`).
- Deactivation could not be confirmed → the delete **stops before any purge**
  (502). Recovery: nothing was changed; retry once the Auth project is reachable.
- Unaccepted invitation (Auth user, no roster/profile rows) → deletable directly;
  confirm by typing the invitee's name or, when no name was set, their email.

**Migration rollback:** s105 only adds objects (two tables + six functions + their
wrappers). To roll back, drop them:
```
drop function if exists public.atlas_team_member_purge_branch(uuid,uuid,uuid,text,text);
drop function if exists public.atlas_team_member_remove_from_team(uuid,uuid,uuid,text,text);
drop function if exists public.atlas_team_member_deletion_preview(uuid,uuid);
drop function if exists public.atlas_team_member_record_photo_orphan(text,uuid,text);
drop function if exists public.atlas_team_member_list_photo_orphans();
drop function if exists public.atlas_team_member_resolve_photo_orphan(text,uuid,text);
drop function if exists atlas_private.team_member_purge_branch(uuid,uuid,uuid,text,text);
drop function if exists atlas_private.team_member_remove_from_team(uuid,uuid,uuid,text,text);
drop function if exists atlas_private.team_member_deletion_preview(uuid,uuid);
drop function if exists atlas_private.team_member_record_photo_orphan(text,uuid,text);
drop function if exists atlas_private.team_member_list_photo_orphans();
drop function if exists atlas_private.team_member_resolve_photo_orphan(text,uuid,text);
drop table if exists atlas_private.team_member_deletion_orphans;
drop table if exists atlas_private.team_member_deletion_audit;  -- keep for audit history unless required
```
The feature also fails closed if the migration is absent: the edge function
returns a clear error and nothing is deleted.

**Edge-function rollback:** redeploy the previous `atlas-team-profiles` build; the
Remove/Delete buttons stop working but no data is affected.

---

### Done / not done

- Done: feature + backend + migration; node, browser and SQL tests; the
  fingerprint re-pin; full migration replay; this checklist.
- Not done (owner approval required): merge PR #129, apply the s105 migration to
  production, deploy `atlas-team-profiles`, and any deletion of a real account.
