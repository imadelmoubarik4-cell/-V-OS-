# S94 Marketing Publishing — proposed production rollout package

Status: **proposal, not approved.** Nothing in this package has been applied to
production. Each numbered stage below needs an explicit owner go-ahead, and
stage 7 (the first real public post) needs its own separate approval.

Branch: `claude/s94-marketing-publishing` at `c23fa2b` (to be brought up to date
with `main` — which now contains S93 Messages — before a PR is opened; see
"Before the PR").

## What ships

| Part | Contents |
|---|---|
| S94A Media library | Private bucket `atlas-marketing-media` (1 GiB object limit, photo/video allowlist, no storage policy), 8 private tables, media RPCs (service-role only), `atlas-marketing-media` gateway, `marketing-media.js` |
| S94B Publishing connections | Publish scopes, account/Page/location choice, publishing-permission states, delivery-scoped credential read, refresh lease, auth-failure marking, Settings › Integrations UI |
| S94C Scheduler & deliveries | Per-platform deliveries, state machine, claim with leases and fencing, retries/backoff, verification after submit, history, push notifications, `atlas-marketing-publisher` worker, pg_cron tick |
| Marketing gateway & UI | `atlas-marketing-workspace` handler (composer, calendar, history, Publish now, TikTok consent), rewritten `marketing-workspace.js` |

**Automatic publishing ships OFF.** Nothing can post publicly until an
administrator turns it on in Marketing and a platform connection is verified
with publishing allowed.

## Current production facts (read-only check, 26 Sep 2026)

- Extensions present: `supabase_vault`, `pgcrypto`. **Missing: `pg_cron`, `pg_net`** (needed only for automatic scheduling; the tick function skips quietly without them).
- Migrations: none of the three S94 migrations are applied.
- Functions: `atlas-marketing-workspace` v3 and `atlas-integrations` v3 are the pre-S94 versions; `atlas-marketing-media` and `atlas-marketing-publisher` do not exist.

## Stages

### 1. Database (owner go-ahead)
Apply in this order with `apply_migration` (never `supabase db push`), one at a
time, verifying after each:
1. `20261004090000_s94a_marketing_media.sql`
2. `20261004091000_s94b_publishing_connections.sql`
3. `20261004092000_s94c_marketing_publishing.sql`

Verify: ledger +3; every new `public.*` S94 RPC is security definer,
`search_path=''`, EXECUTE for `service_role` only; all new tables have RLS and
no browser grants; bucket private with no `storage.objects` policy; baseline
counts (items, qty sum, movements, recipes, suppliers, profiles) unchanged;
advisors show nothing new; automatic publishing setting is `false`.

### 2. Platform prerequisites (owner, dashboard)
- Storage global file-size limit ≥ 1 GiB (needed for video uploads).
- Enable `pg_net` and `pg_cron` (only needed for automatic scheduling; can be deferred while automatic publishing stays off).
- Vault secrets: `atlas_project_url` (the project URL) and `atlas_marketing_publisher_secret` (random, ≥ 32 bytes). Never pasted into chat.

### 3. Function secrets (owner, dashboard — never in chat or browser code)
- `ATLAS_MARKETING_PUBLISHER_SECRET` — same value as the Vault secret.
- Existing `ATLAS_INTEGRATION_KEK_V<n>` / `ATLAS_INTEGRATION_KEK_CURRENT_VERSION` — reused (already project-wide).
- Google and TikTok OAuth client secrets for token refresh (the Meta/Google/TikTok client ids/secrets already configured for S88 integrations, plus the publish scopes on each developer app).
- Optional: `ATLAS_MARKETING_MEDIA_TUS_URL`, `ATLAS_META_GRAPH_VERSION` (default v25.0), `ATLAS_GBP_LANGUAGE`, `ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES`, `ATLAS_PUBLISHER_FB_AUTO_RETRY`.

### 4. Edge Functions (owner go-ahead), all `verify_jwt=false` (auth via `_shared/auth.mjs`)
Deploy from the exact approved commit, packaging the files listed in the release manifests:
1. `atlas-marketing-media` (new)
2. `atlas-integrations` (updated: `_shared/integrations/*`)
3. `atlas-marketing-workspace` (updated: `handler.mjs` + `_shared/integrations/*`)
4. `atlas-marketing-publisher` (new: `_shared/publishing/*`, `_shared/integrations/*`)

Verify each version, boot logs, and an unauthenticated request returns 401;
the publisher refuses requests without the secret (401) and never answers CORS.

### 5. Web (owner go-ahead)
Merge the S94 PR → wait for the Netlify production publish → confirm the
published commit. Cache keys: Marketing `20261004-s94b`, Settings `20261004-s94`.

### 6. Production smoke test — no public posting
With automatic publishing **off**:
- Upload a photo and a short video to the media library; check thumbnails, the JPEG publish copy for a PNG, preview links expire, no storage paths in responses.
- Create a draft with media for each channel; checks panel; save; reopen; "As soon as it's approved" round-trips.
- Submit → approve: deliveries appear as "Ready, not sent"; nothing is claimed.
- Settings › Integrations: each channel shows its real state (not set up / permission missing / choose account / publishing allowed); a bartender cannot see admin controls.
- History and notifications render; a bartender and a viewer are refused publishing actions.
- Logs: no 5xx, no token or signed URL in any log line.

### 7. First live publication — **separate explicit approval required**
Only after the owner has registered the developer apps, connected an account,
pressed "Allow publishing", chosen the Page/account/location, and set the
platform review state. Then, per platform, with the owner present:
turn automatic publishing on → publish one approved test post to the owner's
own test account/Page (TikTok: inbox/draft mode) → verify the permalink →
turn automatic publishing off again if desired. No post to a public
production account without the owner confirming that specific post.

## Rollback
- Web: revert the merge commit (Marketing returns to the pre-S94 module).
- Functions: redeploy the previous versions of `atlas-marketing-workspace` (v3) and `atlas-integrations` (v3) from `main`; leave the new functions unused or delete them.
- Database: the migrations are additive; with automatic publishing off nothing runs. Unschedule the cron job if created. Data can stay in place.

## Before the PR
- Merge `main` (now with S93 Messages) into the branch and re-resolve the release pins/file counts (both branches changed `build_isolated_runtime.py` counts and the S35/S33 manifests), then rerun every suite.
- Open the PR only when asked; do not merge until stages 1–4 are approved.

## Known remaining risks
- No real provider has been called: provider error bodies, TikTok upload throughput, Meta `auth_type=rerequest`, per-permission revoke and Instagram token choice are unverified (listed in `docs/integrations/Atlas_Integrations.md` §10).
- Signed-upload / TUS headers and CORS from the app origin need a check on the first real upload.
- A 403 refresh failure still marks the connection degraded (conservative).
- An asap post approved while automatic publishing is off goes to "needs attention" if publishing is enabled more than 6 hours later (same rule as scheduled posts).
- If a JPEG publish copy is created after approval, the approval fingerprint changes and that post needs re-approval (rare: the copy is made at upload).
