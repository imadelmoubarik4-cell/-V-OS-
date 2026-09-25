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

## S90 workflow integrity rollout

Order: migration first, then the web app. The migration is backward compatible: the current web app keeps calling `adjust_inventory`, and the stock-count verify signature does not change.

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
