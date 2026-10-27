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
| 3 | 🔒 Run `docs/release/sql/S114_apply_staff_access_state.sql` as one script (SQL editor, or the Supabase connector's raw SQL). It refuses unless S113 is recorded and S114 is not, and records its own ledger row `20261031090000`. **Never** use a "create/apply migration" tool or `supabase db push` for it: those record a second, differently numbered ledger row | 🔒 DB | Output; the ledger's last row is `20261031090000`; the four S114 functions exist, service-role only |
| 4 | 🔒 Deploy `atlas-team-profiles` and `atlas-team-profile-photos` from the private checkout, with the settings in `supabase/config.toml` (`verify_jwt = false`). Either `supabase functions deploy <slug> --project-ref <ref> --no-verify-jwt`, or the Supabase connector's deploy with the function's files plus `_shared/auth.mjs` and `_shared/staff-access.mjs`. Both upload straight to Supabase, so nothing becomes public | 🔒 Edge | New version numbers; a signed-in administrator still loads Team |
| 5 | 🔒 Deploy the 23 other gateways that call `resolveActor` (list below), the same way, so every gateway enforces the same rule | 🔒 Edge | New version numbers; the function error rate matches the pre-flight baseline |
| 6 | Push the branch, open the PR with a neutral description, merge to `main` (frontend: the wizard). Netlify publishes it | Owner | Netlify deploy |
| 7 | Smoke checks (below) | Owner | Results recorded |

The 23 gateways for step 5 (each calls `resolveActor` from `_shared/auth.mjs`):
- `atlas-accounting`, `atlas-ai`, `atlas-bookings`, `atlas-integrations`, `atlas-inventory-recognition`
- `atlas-inventory-scanner`, `atlas-item-master`, `atlas-knowledge`, `atlas-marketing-media`, `atlas-marketing-workspace`
- `atlas-notifications` (keeps `verify_jwt = true`), `atlas-operations-checkpoint-a`, `atlas-phase3-brain`, `atlas-phase3-intelligence`
- `atlas-reports` and `atlas-stock-counts` (custom `entrypoint.ts`, as in `config.toml`), `atlas-settings`, `atlas-shifts`
- `atlas-sprint3-review`, `atlas-sprint4-briefing`, `atlas-system`, `atlas-team-messages`, `atlas-training`

Not redeployed: `atlas-booking-email-worker` and `atlas-marketing-publisher`. They only import the `AuthError` type and never call `resolveActor`, so the change does nothing for them. `atlas-public-booking` and the two legacy functions don't use the module at all.

Before each deploy, confirm the function's deployed source still matches pre-S114 `main` (the pre-flight did, byte for byte, for `atlas-team-profiles`). Then the deploy changes only the S114 lines.

## Smoke checks (production, step 7)

Right after step 5, before anything else:
1. An administrator signs in (with their code) and opens Home, Team, Bookings, Inventory and Alcedo AI. Everything loads.
2. A bartender signs in. If they have no authenticator, they enter as before. If they have one, they are asked for the code, enter it, and the app works.
3. The function error rate (pre-flight baseline: no 403s) shows no new 403 or 503 responses for signed-in staff.

After step 6 (the wizard is live). These steps create and remove a real test account, so the owner runs them:

4. Invite a test person (role bartender) and finish the wizard (password, authenticator, details, photo). They become an active bartender.
5. As an administrator, remove that test person in Team. Open their invitation link again, or sign in and open the setup screens. Setup is refused ("can no longer be used"), and in Team they stay inactive.
6. Restore the test person in Team. They can sign in normally. Then permanently delete them.
7. If a manager account exists: as that manager, try to remove an active bartender. It is refused with the administrator message and the bartender stays active.
8. Optional: in a test-only window, set `require_all_staff_mfa = true` and confirm a password-only session is refused (403) while an app session with the code works. Then set it back.

## Rollback: recover without reopening the vulnerabilities

Rolling back the Edge Functions reopens the vulnerabilities this hotfix closes, so it is the last resort, not the first. The S114 database objects are additive and inert on their own (the old functions never call them), so a function problem never needs a database rollback. Data is never touched, so there is nothing to restore.

In order of preference:

1. **Fix forward.** The hotfix is small and fully tested. Patch the one misbehaving function, re-run `npm test` and the S114 tests, and redeploy only that function. Nothing reopens.
2. **Targeted function rollback.** Redeploy the previous source of **only** the misbehaving function, from the pre-S114 commit: `git worktree add /tmp/pre-s114 1a19ba1`, then deploy with the settings in `config.toml`. Every other gateway stays hardened. What reopens, and what to do about it:
   - **A gateway other than Team** (for example Bookings): only the edge two-factor rule for that one gateway. The database still requires the second factor for everything that gateway reads through row security, and the app still asks for the code at sign-in.
   - **`atlas-team-profiles` or `atlas-team-profile-photos`:** self-service account setup is unguarded again. The fix only needs a person with a working login and an inactive profile, so for the duration, an administrator also bans every inactive account in Supabase → Authentication → Users. A banned account cannot sign in at all.
3. **Full function rollback** (every S114 function), only if the shared sign-in check itself fails for everyone (for example the policy read fails in production). Apply the same ban as in 2, and fix forward as soon as possible.
4. **Database rollback:** only if the S114 database objects themselves are at fault, and only after any function that calls them has been rolled back. Run `docs/release/sql/S114_staff_access_state_rollback.sql`. It drops the S114 functions and the S114 ledger row, is idempotent, and is proven by a test to leave nothing behind (verified on a replayed database: `tests/sql` and step 0 of `scripts/release/verify_kanel_bookings_rollback.sh`). If the database is rolled back while the S114 Team function is live, that function refuses every pending invitation (fail closed, never open).
5. **Frontend:** Netlify "Publish deploy" of the previous production deploy, or `git revert` of the wizard commit. The old wizard works against the new functions while "two-factor for all staff" is off, because inactive invitees are exempt from the edge two-factor rule and setup is checked by the server.

The Auth `app_metadata` markers written after the rollout are harmless under the old code. `atlas_access_revoked_at` and `atlas_onboarding_completed_at` are simply ignored, so no cleanup is needed.

## Decisions for the owner

1. **Managers removing active members.** The database already allows only administrators to change another person's access, so a manager's "remove" never took effect. S114 makes the screen say so instead of reporting success. If managers should be able to remove bartenders and viewers, that needs a separate, reviewed database change.
2. **Invitation lifetime.** 14 days (`INVITATION_MAX_AGE_DAYS` in `_shared/staff-access.mjs`). A fresh invitation from Team restarts it.
