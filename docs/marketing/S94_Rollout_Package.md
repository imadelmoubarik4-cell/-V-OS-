# S94 Marketing Publishing — production rollout package

Status: **ready for a separate owner production approval — nothing applied.**
No migration, extension, secret, function, web merge or real post has been
made in production. Each stage below needs its own owner go-ahead; stage 7
(the first real public post) needs a further, specific approval.

## Exact source

| | |
|---|---|
| Branch | `claude/s94-marketing-publishing` |
| Reviewed code and tests | **`ffa4e901539bf60678f2f55649b074a314e87e11`** (the Media fixes proved end to end on the real Storage API; supersedes `ad2bee0`, which cannot upload videos over 6 MB) |
| Commits after it | documentation only (this package); check with `git diff --stat ffa4e90..HEAD` — it must list only `docs/marketing/*.md` |
| Contains `main` | yes, up to `51e4fe8` (S93 Messages); reconciled in merge `de48579` |

Deploy functions and web **from `ffa4e90` or the docs-only head**, nothing else.

## What ships

| Part | Contents |
|---|---|
| S94A Media library | Private bucket `atlas-marketing-media` (1 GiB object limit, photo/video allowlist, no storage policy), private tables, service-role-only RPCs, `atlas-marketing-media` gateway, `marketing-media.js` |
| S94B Publishing connections | Publish scopes, account/Page/location choice, publishing-permission states, delivery-scoped credential read, refresh lease, auth-failure marking, Settings › Integrations UI |
| S94C Scheduler & deliveries | Per-platform deliveries, state machine, claims with leases and fencing, retries/backoff, verification after submit, history, notifications, `atlas-marketing-publisher` worker, `marketing_publisher_tick()` (no cron job is created by the migration) |
| Marketing gateway & UI | `atlas-marketing-workspace` handler (composer, calendar, history, Publish now, TikTok consent), rewritten `marketing-workspace.js` |

**Automatic publishing ships OFF, and the scheduler ships NOT INSTALLED.**

## Acceptance evidence (reconciled branch with the Media fixes, 26 Sep 2026)

| Suite | Result |
|---|---|
| `npm run test:node` | 1261 tests: 1219 pass, 0 fail, 42 skipped |
| `npm run test:python` | 283 tests OK, 4 skipped |
| Full migration replay | passed, 138 migrations |
| SQL previews | all 9 pass: s90 16/16, s90f 7/7, s90g 6/6, s90h 3/3, s91 18/18, s93 14/14, s94a 56/56, s94b 177/177, s94c 75/75 |
| Claim concurrency / load | 200-delivery race: 0 double-claimed; pgbench 300 deliveries: 0 double-claimed, 0 double-published |
| Scheduler proof (`verify_s94_publisher_schedule.sh`, real pg_cron 1.6) | 9/9 |
| Browser (Marketing, media, Settings, Integrations, teamc, shell, shell-ui, Messages, phone UI, Home) | 132 tests: 131 pass, 0 fail, 1 skipped (screenshot-only) |
| Media end to end on the real Storage API (`scripts/e2e/s94-media/run.sh`: storage-api v1.11.13, PostgREST, replayed database, the real handler, `apps/web` in Chromium) | gateway 109/109, browser 40/40, orphan/log/boundary checks after the browser run 13/13; `s94_media_smoke_check.sql` passes on the same data |
| Edge auth gates (`s94-edge-auth-gates.test.js`) | 5/5: all four functions refuse unauthenticated requests with no backend call; publisher refuses missing/wrong secret, answers no CORS preflight, never logs the secret |
| Supabase advisors (splinter, run on a replay of `main` vs this branch) | no new security findings; only new items are 24 × INFO `unused_index` for the new, still-empty S94 tables (expected before use) |

## Production facts (read-only check, 26 Sep 2026)

- Extensions present: `supabase_vault`, `pgcrypto`. Not present: `pg_cron`, `pg_net` (only stage S needs them).
- No S94 migration applied. `atlas-marketing-workspace` v3 and `atlas-integrations` v3 are pre-S94; `atlas-marketing-media` and `atlas-marketing-publisher` do not exist.

## Configuration, in three groups

Values are set by the owner in the Supabase dashboard (Edge Functions → Secrets,
or Vault). Never in chat, never in browser code, never in public settings.

### A. Infrastructure required for S94 itself

| Name | Where | Needed for |
|---|---|---|
| `ATLAS_INTEGRATION_KEK_V1` (and `ATLAS_INTEGRATION_KEK_CURRENT_VERSION` when rotating) | function secret | encrypting/decrypting stored tokens; already required by S88 Integrations — confirm it is present |
| `ATLAS_INTEGRATIONS_PUBLIC_URL`, `ATLAS_INTEGRATIONS_APP_ORIGINS`, `ATLAS_INTEGRATIONS_CALLBACK_HOSTS` | function secrets | OAuth callbacks and redirects back to the app (S88; confirm unchanged) |
| `ATLAS_MARKETING_PUBLISHER_SECRET` | function secret | the worker refuses every request without it (≥ 32 characters, random) |
| Storage global file-size limit ≥ 1 GiB | project setting | video uploads |
| Optional: `ATLAS_MARKETING_MEDIA_TUS_URL`, `ATLAS_VENUE_TIMEZONE`, `ATLAS_PUBLISHER_WALL_BUDGET_MS`, `ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES`, `ATLAS_PUBLISHER_FB_AUTO_RETRY` | function secrets | defaults are safe |
| Stage S only: Vault `atlas_project_url`, Vault `atlas_marketing_publisher_secret` (same value as the function secret), `pg_net`, `pg_cron` | Vault / extensions | the automatic scheduler |

### B. Per-provider OAuth credentials — only when that provider is connected

| Provider | Secrets |
|---|---|
| Facebook Pages, Instagram | `ATLAS_META_APP_ID`, `ATLAS_META_APP_SECRET`; optional `ATLAS_META_GRAPH_VERSION` (default v25.0) |
| Google Business Profile | `ATLAS_GOOGLE_OAUTH_CLIENT_ID`, `ATLAS_GOOGLE_OAUTH_CLIENT_SECRET`; optional `ATLAS_GBP_LANGUAGE` |
| TikTok | `ATLAS_TIKTOK_CLIENT_KEY`, `ATLAS_TIKTOK_CLIENT_SECRET` |

A provider without its credentials simply shows "Not set up" in Settings;
nothing else is affected.

### C. Provider publishing prerequisites — before any real publication

| Provider | Owner must have |
|---|---|
| Meta (Facebook + Instagram) | Meta app with the publish permissions (`pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish`, `instagram_basic`, `business_management` as listed in contract §4) approved in App Review; the Instagram account is a Business/Creator account linked to the Page; the connecting person has content-creation rights on the Page |
| Google Business Profile | Google Cloud project with the Business Profile APIs enabled and API access approved; OAuth consent screen verified for `business.manage`; the account is an owner/manager of the location |
| TikTok | TikTok developer app with the Content Posting API and the `video.upload` (inbox) / `video.publish` (Direct Post) scopes; until TikTok's audit approves Direct Post, only inbox (draft) uploads work — the creator finishes the post in the TikTok app |
| All | In Atlas: connect, press **Allow publishing**, choose the Page/account/location, set the platform review state (administrator) |

## Stages

Order is fixed. Each stage: owner go-ahead → do → verify → report → next.

### 1. Database
Apply one at a time with `apply_migration` (never `supabase db push`):
1. `20261004090000_s94a_marketing_media.sql`
2. `20261004091000_s94b_publishing_connections.sql`
3. `20261004092000_s94c_marketing_publishing.sql`

Verify after each: ledger +1; new `public` S94 functions are security definer
with `search_path=''` and EXECUTE for `service_role` only; new tables have RLS
and no browser grants; bucket private with no `storage.objects` policy;
baseline counts unchanged (items, quantity sum, movements, recipes,
suppliers, profiles); advisors show nothing new beyond INFO `unused_index`;
`atlas_private.marketing_automatic_publishing_enabled()` = `false`; no cron job exists.

### 2. Infrastructure configuration (group A, owner)
Storage limit; `ATLAS_MARKETING_PUBLISHER_SECRET`; confirm the S88 integration
secrets. Not the Vault/extension items (those are stage S).

### 3. Provider credentials (group B, owner — only for providers being connected now)

### 4. Edge Functions — all `verify_jwt=false` (authentication in `_shared/auth.mjs`)
Deploy from the exact source commit, packaging the files the release manifests list:
1. `atlas-marketing-media` (new)
2. `atlas-integrations` (updated; `_shared/integrations/*`)
3. `atlas-marketing-workspace` (updated; `handler.mjs` + `_shared/integrations/*`)
4. `atlas-marketing-publisher` (new; `_shared/publishing/*`, `_shared/integrations/*`)

Verify for each: new version active; boot logs clean; a request without a
session → 401 (media, workspace, integrations); publisher: no secret → 401,
wrong secret → 401, browser preflight not answered, no `access-control-*`
header, and the secret absent from logs.

### 5. Web
Merge the S94 PR (opened only when asked) → wait for the Netlify production
publish → confirm the published commit. Cache keys: `marketing-media.js` and
Marketing CSS `20261004-s94c`, the other Marketing scripts `20261004-s94b`,
Settings `20261004-s94`.

### 6. Production smoke test — no public posting, automatic publishing OFF, no scheduler
Media (the strengthened check):
1. In Marketing › Media, upload five files named with the prefix `atlas-smoke-`:
   a JPEG, a PNG, a WebP, an iPhone HEIC (upload from Safari; Chrome cannot
   decode HEIC and refuses it with the "convert to JPEG or use Safari" message —
   also confirm that message), a short MP4, and an MP4 over 6 MB (it goes by
   the resumable TUS upload; check in DevTools that it posts to
   `…storage.supabase.co/storage/v1/upload/resumable/sign` and gets `201`).
2. Run `scripts/s94_media_smoke_check.sql` (read-only) in the SQL editor —
   every row must be `true`: bucket private with the allowlist and no policy;
   each file ready with the sniffed type matching its extension; server-read
   width/height; stored size matches; **PNG, WebP and HEIC each have a ready
   `image/jpeg` publishing copy with dimensions, stored in the private bucket**;
   thumbnails/poster ready.
3. In the browser (DevTools → Network) on the media library and a post using
   the media: no response contains `storage_path`, `object_name` or a bucket
   path; image links are signed URLs; open one preview link, wait 6 minutes,
   reload it → it is refused (expired). Opening the bucket's public URL for an
   original returns an error (private).
4. The composer shows the PNG/WebP/HEIC photo as publishable for Instagram
   (the JPEG copy is used) — without publishing.

Workflow:
5. Create a draft with media for each channel; checks panel; save; reopen;
   "As soon as it's approved" round-trips.
6. Submit → approve: deliveries appear as "Ready, not sent"; nothing is claimed;
   no publisher log line.
7. Settings › Integrations: each channel shows its real state; bartender and
   viewer see no admin controls and are refused publishing actions.
8. Logs: no 5xx, no token, signed URL or secret in any line.

### S. Scheduler — optional, separate approval (runbook: `S94_Scheduler_Runbook.md`)
Can be skipped entirely while automatic publishing stays off.
1. Enable/verify happens inside the script; the owner first adds the two Vault secrets.
2. Run `scripts/s94_publisher_schedule_install.sql` once. Expected: one job
   `atlas-marketing-publisher-tick`, `* * * * *`, active; `automatic_publishing_on = false`.
3. Watch two runs in `cron.job_run_details` (`succeeded`) and confirm the
   publisher shows no tick calls while nothing is due.
4. Kill switch: `select cron.unschedule('atlas-marketing-publisher-tick');`

Duplicate protection (proven locally with real pg_cron, see runbook):
`cron.schedule()` upserts by name; the script is advisory-locked; it refuses if
another job calls the tick; it aborts unless exactly one job calls the tick.

### 7. First live publication — separate, specific approval
Only after group C is complete for that provider, and with the owner present:
turn automatic publishing on (or use Publish now) → one approved test post to
the owner's own test Page/account (TikTok: inbox mode) → verify the permalink
and History → decide whether to leave automatic publishing on. No post to a
public production account without the owner confirming that specific post.

## Rollback
- Scheduler: `select cron.unschedule('atlas-marketing-publisher-tick');`
- Product stop: Marketing → Automatic publishing off.
- Web: revert the merge commit (Marketing returns to the pre-S94 module).
- Functions: redeploy `atlas-marketing-workspace` v3 and `atlas-integrations` v3 sources from `main`; leave the new functions unused or delete them.
- Database: migrations are additive; with automatic publishing off and no job nothing runs; data can stay.

## Remaining risks (provider-specific, need the first real use)
- **Meta:** `auth_type=rerequest`, per-permission revoke (`DELETE /me/permissions/{permission}`), `CREATE_CONTENT` gating for Instagram, Page-token vs user-token per Instagram edge, Business-portfolio Pages paging, real error bodies and rate headers.
- **Instagram/Facebook video:** processing times vary; Facebook page videos are never retried automatically (they go to "Needs attention" after verification) — intended, but a manual check may be needed.
- **TikTok:** Direct Post needs TikTok's audit (inbox only until then); upload throughput vs the 140 s run budget and the 60 s minimum is an estimate; rotating refresh tokens and error codes unverified.
- **Google Business Profile:** API access approval; whether a `SITE_MANAGER` may post (treated as not selectable).
- **Media:** signed upload / TUS headers and CORS from the app origin are verified only on the first real upload (stage 6).
- **Behavioural:** a 403 refresh failure marks a connection degraded; an "as soon as approved" post approved while automatic publishing is off goes to "Needs attention" if publishing is enabled more than 6 hours later; a JPEG copy created after approval changes the approval fingerprint (re-approval needed; rare).
