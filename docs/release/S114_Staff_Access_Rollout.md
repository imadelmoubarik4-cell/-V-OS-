# S114 staff access hardening: rollout and rollback

Status: **prepared, not deployed.** Every step marked 🔒 needs the owner's separate approval.

Scope:
- **Edge Functions:** the `_shared/auth.mjs` staff two-factor check and the account-setup guards in `atlas-team-profiles` and `atlas-team-profile-photos`.
- **Database:** two additive, service-role-only database functions (`20261031090000_s114_staff_access_state.sql`): a read-only access-history check, and the locked step that activates a pending invitation when its setup finishes.
- **Frontend:** the invitation wizard (`account-invitation.js`, `invitation.html`): the authenticator step now comes second (password → authenticator → details → photo), and refusals show plain-language messages.

There are no table, policy or data changes.

Reference: `ALCEDO_Security_Fix_Report.md`, delivered privately, holds the technical detail. Keep it out of public issues and PRs.

## What changes for people

| Who | Effect |
| --- | --- |
| Staff signing in normally (the app already asks anyone with an authenticator for their code) | Nothing. |
| A browser tab that signed in with a password only, from someone who has since set up an authenticator | Requests are refused until they confirm their code. Reloading the app asks for it. |
| Everyone, once the owner turns on "two-factor for all staff" (`require_all_staff_mfa`) | Every request needs a confirmed second factor, exactly as the database already requires. |
| A new invitee finishing setup | They set up the authenticator before their details and photo. Otherwise unchanged. |
| A person whose access was removed | They can no longer use the setup screens. They see "This invitation can no longer be used". |
| An invitation older than 14 days, or from someone who is no longer an active manager/administrator | Setup asks them to contact a manager. A manager sends a fresh invitation (if they haven't accepted it yet) or an administrator activates them in Team. |
| An administrator changing the role of a pending invitation in Team | The new role is what they get when they finish setup, even when the profile already showed it. |
| A manager (not an administrator) removing an **active** member in Team | Refused with "Only an administrator can remove this member’s access". This was already blocked by the database, but the screen used to report success. Managers can still cancel a pending invitation. |
| A manager changing a pending invitation's role in Team | Refused: only an administrator can. The database already allowed only administrators to change access; the change used to fail with a vague message. |
| Inviting someone whose access was removed, or who already accepted an invitation | Refused before anything is sent, with what to do instead (an administrator restores or activates them in Team). |
| An invitation whose tracking could not be saved | The manager is told (503) instead of seeing a success the invitee could never use. |
| A login member a manager created, finishing setup | Their name is recorded only if none is on record; role and access stay as the manager set them. |
| An inactive profile from before the security audit existed (rare) | An administrator activates it from Team. Setup refuses it, and the pre-flight lists such profiles. |

## Order

The database function comes first, because the new Edge Functions read it and **fail closed** without it.

| # | Step | Gate | Evidence |
| --- | --- | --- | --- |
| 0 | Review the hotfix privately: it is delivered as a git bundle, **not** pushed, because this repository is public. Steps 1–5 run from a local checkout of that bundle; the code becomes public only at step 6, after production is fixed | Owner | Review notes |
| 1 | Run `docs/release/sql/S114_preflight_readonly.sql` in the production SQL editor (read-only) | Owner | Output saved: **all four prerequisites true except `s114_already_applied` (false)**; flags; staff with factors; inactive-profile table. Stop if `auth_policy_rpc_present` is false: the new code refuses password-only requests while it cannot read the policy |
| 2 | Act on the pre-flight's inactive-profile table. Anyone still waiting to join who is listed as "expired" or "inviter may no longer give this role": send a fresh invitation from Team after the rollout (if Team says they already accepted it, an administrator activates them instead). Anyone listed as "pre-audit" or "access was removed" who should be working: an administrator activates them in Team. Anyone who should not have access: leave them inactive | Owner | Team changes |
| 3 | 🔒 Paste `docs/release/sql/S114_apply_staff_access_state.sql` into the SQL editor and run it. It refuses unless S113 is recorded and S114 is not, and records its ledger row | 🔒 DB | Output; `select public.atlas_team_profile_access_state('<an active profile id>')` as service role returns seven keys with `"ever_active": true` |
| 4 | 🔒 Deploy `atlas-team-profiles` and `atlas-team-profile-photos` (`supabase functions deploy <slug> --project-ref <ref> --no-verify-jwt`, with flags exactly as in `supabase/config.toml`) | 🔒 Edge | CLI output |
| 5 | 🔒 Deploy every other function that imports `_shared/auth.mjs` (list below), the same way | 🔒 Edge | CLI output |
| 6 | Push the branch, open the PR with a neutral description, merge to `main` (frontend: the wizard). Netlify publishes it | Owner | Netlify deploy |
| 7 | Smoke checks (below) | Owner | Results recorded |

Functions that import `_shared/auth.mjs` (redeploy all of them in step 5 so every gateway enforces the same rule):
- `atlas-accounting`, `atlas-ai`, `atlas-booking-email-worker`, `atlas-bookings`, `atlas-integrations`
- `atlas-inventory-recognition`, `atlas-inventory-scanner`, `atlas-item-master`, `atlas-knowledge`
- `atlas-marketing-media`, `atlas-marketing-publisher`, `atlas-marketing-workspace`, `atlas-notifications`
- `atlas-operations-checkpoint-a`, `atlas-phase3-brain`, `atlas-phase3-intelligence`, `atlas-reports`
- `atlas-settings`, `atlas-shifts`, `atlas-sprint3-review`, `atlas-sprint4-briefing`
- `atlas-stock-counts`, `atlas-system`, `atlas-team-messages`, `atlas-training`
- plus `atlas-team-profiles` and `atlas-team-profile-photos` (step 4)

## Smoke checks (production, step 7)

1. An admin signs in (with their code) and opens Home, Team, Bookings, Inventory and Alcedo AI. Everything loads.
2. A bartender who has an authenticator signs in. They are asked for the code and enter it, and the app works.
3. Invite a test person (role bartender) and finish the wizard (password, authenticator, details, photo). They become an active bartender.
4. As an administrator, remove that test person in Team. Open their invitation link again, or sign in and open the setup screens. Setup is refused ("can no longer be used"), and in Team they stay inactive.
5. Restore the test person in Team. They can sign in normally. Then remove or delete them again.
6. As a manager, try to remove an active bartender: it is refused with the administrator message and the bartender stays active.
7. Optional: in a test-only window, set `require_all_staff_mfa = true` and confirm a password-only session is refused (403) while an app session with the code works. Then set it back.

## Rollback (verified on a replayed database: tests/sql + scripts/release/verify_kanel_bookings_rollback.sh step 0)

Fastest first. Data is never touched; nothing to restore.

1. **Edge Functions:** redeploy the previous sources from the pre-S114 commit (`git worktree add /tmp/pre-s114 <pre-S114 main SHA>`, then `supabase functions deploy <slug> --project-ref <ref>`, with flags as in `config.toml`), for the functions deployed in steps 4–5. This alone restores the previous behaviour.
2. **Database (after step 1):** run `docs/release/sql/S114_staff_access_state_rollback.sql`. It drops the S114 functions and the S114 ledger row, is idempotent, and is proven by a test to leave nothing behind.
3. **Frontend:** `git revert` of the wizard-copy commit, or Netlify "Publish deploy" of the previous production deploy.

Do **not** roll back the database before the Edge Functions. The S114 functions would then refuse every pending invitation (fail closed) until they are rolled back too.

The Auth `app_metadata` markers written after the rollout are harmless if the code is rolled back. `atlas_access_revoked_at` and `atlas_onboarding_completed_at` are ignored by the old code, so no cleanup is needed. Note that rolling back the Edge Functions also reopens both security issues; do it only for a real outage.

## Decisions for the owner

1. **Managers removing active members.** The database already allows only administrators to change another person's access, so a manager's "remove" never took effect. S114 makes the screen say so instead of reporting success. If managers should be able to remove bartenders and viewers, that needs a separate, reviewed database change.
2. **Invitation lifetime.** 14 days (`INVITATION_MAX_AGE_DAYS` in `_shared/staff-access.mjs`). A fresh invitation from Team restarts it.
