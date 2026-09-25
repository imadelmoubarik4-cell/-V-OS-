# Deployment

Netlify publishes `apps/web` as configured in `netlify.toml`. The application requires the existing Supabase project URL and publishable key in `apps/web/config.js`.

## Safe order

1. Run `npm run verify`.
2. Review the Git diff for source PDFs, quantities, costs, secrets, and generated private data.
3. Compare the repository migration versions with the hosted migration ledger.
4. Back up the production schema and affected inventory/import tables.
5. Apply and test A.2 on a development database.
6. Re-run Supabase security and performance advisors.
7. Apply the reviewed A.2 migration to production through the controlled migration workflow.
8. Deploy the static web directory.
9. Test manager/admin access, redacted staff reads, denied anonymous/bartender writes, queue upload, review, cancellation, retry, and deletion.

The five recovered migrations are already recorded on the hosted project and must not be manually replayed there. They exist so clean environments have the same history. A.2 is intentionally not applied merely by deploying this repository.

## Release-gated migrations: apply after the web deploy

Two migrations must be applied only **after** the new `apps/web` is live. Apply every other migration first.

- `20260927099000_s89_revoke_direct_item_insert.sql`
- `20260928095000_s89_revoke_direct_item_update.sql`

They revoke direct browser INSERT and UPDATE on `public.inventory_items`. Until the new web app is deployed, any client still running the old build gets "permission denied" when it adds or edits an item.

Do not run `supabase db push` against production for this release:

- It would apply these two files in filename order, before the web deploy.
- The hosted ledger records migrations applied through the controlled workflow under their own version timestamps, so the file versions do not line up with the ledger.

Apply each file explicitly, in the order given by the release's rollout plan:

1. All pending migrations except these two.
2. Functions.
3. The web app, followed by a smoke test on the new build.
4. `20260927099000`, then `20260928095000`.

After step 4, re-run the smoke test for adding and editing an item.

`scripts/rollout_s87_s90.sh` runs this order: `check` (read-only), `migrations` (batch A, 31 files), `functions`, then `revokes` only with `WEB_DEPLOYED_AND_SMOKE_TESTED=yes`. It needs `SUPABASE_DB_URL` and, for functions, `SUPABASE_ACCESS_TOKEN`. Each file is applied and recorded in the ledger in one transaction, matched by name, and a re-run skips what is already applied.

If the Supabase GitHub integration is set to deploy migrations to production when `main` changes, turn that off before merging this release. Otherwise the merge would apply every file in filename order: the revokes would run before the web deploy, and `20260924170000` would be replayed (production recorded it as `20260924150124`).

## S92: Accounting (invoices, receipts, reimbursements)

Apply only after S91 is live and the desktop/phone retest has passed. The release is additive: nothing existing changes.

Order, with `scripts/rollout_s92.sh`:

1. `check`: read-only. It confirms that S91 is recorded, that its dependencies exist, and that S92 is pending.
2. `migration`: applies `20261001090000_s92_accounting_documents.sql` and records it in the ledger, in one transaction. It creates:
   - the private tables `atlas_private.accounting_documents` and `atlas_private.accounting_document_events` (RLS on, service role only);
   - the private bucket `atlas-accounting-documents`, with no storage policy;
   - the `public.atlas_accounting_*` RPCs, which only `service_role` may execute. Each one checks again that the actor is an active admin.
3. `function`: deploys `atlas-accounting`. It uses the same secrets as `atlas-inventory-recognition`. `OPENAI_API_KEY` is optional: without it, or while Atlas AI is off in Settings, documents are typed in by hand.
4. Web: merge the S92 PR so that Netlify publishes it. `accounting-workspace.js?v=20261001-s92a` and `purchasing.css?v=20261001-s92a` must load.

Checks:
- `scripts/verify_s92_accounting_preview.sql` covers the roles, the workflow, retention and export. It runs on a replayed database via `verify_s90_workflow_integrity_previews.sh`.
- After the rollout, sign in as an admin: Accounting appears under Business. Sign in as a manager: it does not appear, and `#accounting` shows the administrators-only notice.

Retention (Icelandic bookkeeping law, 7 years): documents cannot be deleted, and their history is append-only.
- A mistaken upload that was never approved is discarded. Its file is removed; the record and its history are kept.
- An approved document can only be voided, with a reason. It keeps its file.

Atlas reads a document only when both of these hold:
- Atlas AI is on (Settings › Atlas AI, `ai_settings.enabled`);
- a key is set.

Reads are limited to 60 per rolling 24 hours. A read only fills empty fields and never approves anything.

## S91: live voice lease and device handoff

`20260930092000_s91_voice_lease_and_takeover.sql` is the last file of batch A. Apply it, then deploy
`atlas-ai`, then the web app (`atlas-ai.js` / `atlas-ai-voice.js` `?v=20260926-s91b`), close together:
the new web app sends `heartbeat: true` on `voice-session`, gets a 2-minute idle lease and renews it
with `voice-heartbeat` every 45 seconds. Without that flag (the currently deployed atlas-ai, or a tab
still running an older web app) the lease stays 10 minutes as before, so an open older tab is not cut
off. The migration keeps the old `atlas_ai_voice_session_start` parameters first with the same
defaults, so the currently deployed `atlas-ai` keeps working until it is redeployed. The web app's
`atlas-ai-voice.js` changed again in S91c (the heartbeat flag and saving a replaced device's last
lines): its `index.html` key must move to `?v=20260926-s91c`.
`scripts/verify_s91_voice_preview.sql` (run by `verify_s90_workflow_integrity_previews.sh`) proves the
lease, the heartbeat, the same-user takeover and that quotas still count.

The same `atlas-ai` deploy carries the photo-count fix ("Count these bottles") and the recognition
tool change (`_shared/ai-tools`, `_shared/recognition`); deploy `atlas-inventory-recognition` too, as it
shares the recognition modules. `atlas-integrations` carries the owner-facing "Not set up yet" copy and
the admin-only setup details; the web app's `settings-workspace.js` (`?v=20260926-s91b`) shows them.

## S90g: item-master publication behind a private definer

`20260930090000_s90g_item_master_update_definer.sql` is part of batch A and must be applied before the revokes. On production, `public.atlas_apply_item_master_update` is a SECURITY INVOKER function that `authenticated` may execute: production applied the Phase 1 grant reset before this function existed, while the repository history resets grants after it. `atlas-item-master` calls it with the signed-in manager's token, so after `20260928095000` revokes UPDATE on `inventory_items`, publishing would fail with "permission denied".

The migration keeps the signature and messages. It moves the body into `private.apply_item_master_update` (SECURITY DEFINER, not exposed by the API) behind an invoker wrapper with the manager check. The security gate lists it with the other reviewed browser RPCs, and `scripts/verify_s90g_item_master_definer_preview.sql` proves that a manager can publish after the revokes, a bartender gets 42501, and anon has no access.

Temporary `pg_net`: an earlier rollout attempt enabled `pg_net` (it installed in `public`). Nothing uses it. Remove it once its queue is empty: `select count(*) from net.http_request_queue;` must return 0, then run `drop extension if exists pg_net;`.

## S90 workflow integrity rollout

Order: migration first, then the web app (the two release-gated revokes above come after the web deploy). The migration is backward compatible: the current web app keeps calling `adjust_inventory`, and the stock-count verify signature does not change.

1. Apply `20260929090000_s90_stock_adjust_idempotency.sql` through the controlled migration workflow. It adds:
   - `public.adjust_inventory_v2`: an invoker wrapper over `private.adjust_inventory_request`, a manager-gated definer.
   - `atlas_private.stock_adjustment_requests`: a private ledger of request ids, one row per actor and request id.
   - A new `atlas_private.stock_count_verify` that stamps each verified balance at the line's `counted_at`.
   Then apply `20260929092000_s90f_ai_update_draft_order_kind.sql`. It adds the Atlas AI proposal kind `purchase_order.update_draft` to `atlas_private.ai_action_allowed_roles` (admin and manager only). Apply it before deploying `atlas-ai`: until then, a proposal to add lines to a supplier's existing draft is refused as an unknown kind.
2. Run `scripts/verify_s90_workflow_integrity_previews.sh` against a replayed database (it also runs `verify_s90f_ai_update_draft_preview.sql`). `scripts/verify_phase1_security_gate.sql` now reviews `adjust_inventory_v2` alongside the other browser RPCs.
3. Deploy `apps/web`. Recording waste and deliveries without an order now uses `adjust_inventory_v2`. The asset `?v=` query strings in `index.html` belong to the shell work, so bump them in the same release so browsers do not keep the old scripts.
4. Deploy `atlas-team-profiles` and `atlas-settings`:
   - `atlas-team-profiles`: invitations send `full_name` (the key `handle_new_user` reads) and `display_name`. They redirect to `<app origin>/invitation.html`. The app origin comes from `ATLAS_APP_ORIGIN`, falling back to the first entry of `ATLAS_INTEGRATIONS_APP_ORIGINS` and then `https://os-vabar.netlify.app`. Only a bare https origin is accepted.
   - `atlas-settings`: save-hours refuses these opening hours:
     - zero-length days;
     - a close before the open without "Next day";
     - more than 24 hours;
     - a late close that overlaps the next day's opening.

Owner checks (hosted Supabase settings, not in this repository):

- **Auth → URL Configuration → Redirect URLs** must allow `https://<app origin>/invitation.html`. Otherwise Supabase falls back to the Site URL.
- **Auth → Email Templates → Invite user** must link to the redirect URL with the token hash. `invitation.html` completes the invite with `verifyOtp({ token_hash, type: 'invite' })`, for example `<a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}">Set up your Atlas login</a>`. The default `{{ .ConfirmationURL }}` template signs the invitee in without the set-password step.
- Before the migration, check how many sessions are submitted but not yet verified. After it, a verified count's baseline is the time each line was counted. Deliveries or waste recorded after that time now add to the count, where before they were dropped.
