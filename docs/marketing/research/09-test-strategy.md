# S94 Marketing Publishing Platform: test strategy

Worktree: `/home/user/-V-OS-/.claude/worktrees/s94` @ `5120a42`. Read-only survey. Every probe below was run locally on 2026-09-26.

---

## 1. Existing test infrastructure (Marketing and integrations)

### 1.1 Marketing coverage today
| File | Kind | What it covers |
|---|---|---|
| `tests/node/marketing-workspace-ui.test.js` (87 lines) | static source regex | config wiring, tabs, "publishing is manual", no provider hosts in the browser JS, editor labels, venue-clock helpers (`localInputValue`/`fromLocalInput`, no `getTimezoneOffset`), gateway-only access (no `.from(`), CSS in `@layer atlas.modules` |
| `tests/python/test_marketing_workspace_contract.py` (196 lines) | static migration/source contract | RLS and revokes on `atlas_private.marketing_*`, content types and statuses, connection states (`not_connected … connection_expired`), `automatic_publishing_enabled` false, audited approval RPCs |
| `tests/browser/teamc.browser.test.mjs` lines 191–242, plus `teamc-fixtures.mjs::marketingWorkspace()` | Playwright | overview in `America/New_York` shows venue time and `create-content` posts `scheduled_for` in Reykjavík wall time; approve/changes_requested (a note is required); bartender sees "Marketing is for managers"; 390px calendar has no horizontal scroll |
| `tests/node/shell-contract-s88.test.js` | static | `registerView('marketing')`, cache keys (marketing is lazy-loaded through `apps/web/config.js:118-119` with `?v=` keys) |
| `tests/node/edge-auth-contract.test.js`, `ai-tools-*` | static | the Edge auth pattern, and marketing as an AI tool domain |

The browser has no media, publishing, provider, worker or SQL-preview test for Marketing yet. `supabase/functions/atlas-marketing-workspace/index.ts` is a 584-line `Deno.serve` monolith with `WRITE_ROLES = admin, manager, bartender` and `MANAGER_ROLES = admin, manager`.

### 1.2 Integrations (the model to copy)
- `supabase/functions/atlas-integrations/{handler.mjs,oauth-core.mjs,providers.mjs,index.ts}`: a dependency-injected `createIntegrationsHandler({ env, fetchImpl, rpc, authenticate, now })`, with `index.ts` as a thin shell.
- `tests/node/integrations-oauth-s88.test.js` (747 lines):
  - `fakeDatabase()` is an in-memory RPC switch that mirrors the SQL rules (role gate, single-use state, `connected` only with a credential, `expired` on `p_needs_reauthorization`).
  - `harness({ env, role, verifyOk })` injects a scripted `fetchImpl` for Google token, Drive about and revoke.
  - `assertNoLeak(text)` scans every response for the access token, refresh token, client secrets and KEK.
  - It also has source-contract tests: the browser bundle holds no secret names, and the migration keeps credentials away from browser roles.
  - The S94 worker should reuse this pattern: `fakeDatabase` + `fetchImpl` + `now` + `assertNoLeak`.
- `tests/node/helpers/edge-function-harness.js::loadEdgeFunction(path, env)` runs a real `index.ts` under Node:
  - It strips types, stubs `Deno.env`/`Deno.serve` and returns `call(request, fetchImpl)`.
  - It is used by `stock-truth-edge-functions-s88.test.js` (fake auth at `https://auth.test`, RPC at `https://branch.test`, and an unexpected URL throws) and by 5 other tests.
  - Use it for any function that stays a monolith, such as the extended `atlas-marketing-workspace`.
- `scripts/verify_s88_integrations_preview.sql` has `pg_temp.s88_has_secret_keys(jsonb)`, a regex for credential-shaped keys applied to every jsonb the browser can receive. S94 should reuse it for publishing snapshots and events.
- `supabase/s33/functions/atlas-import-worker/worker.mjs` + `tests/node/s33-import-worker.test.js` are an existing worker `createHandler` pattern.
- `atlas-notifications` `dispatch` uses a shared-secret header (`x-atlas-dispatch-token`) compared with `!==`, which is not constant-time. The S94 worker secret should use a constant-time compare and be tested (section 6, SEC-4). The existing claim `atlas_push_notification_claim` (migration `20260911124039…:232`) already uses `for update skip locked`, so S94 has an in-repo precedent.

### 1.3 Browser harness facts (`tests/browser/harness.mjs`)
- **Backend mocks:** fixtures are `{ tables, rpc, writes, functions, auth }`. `functions[fn](ctx)` returns a body, `{__status, body}` or `{__raw:{status,contentType,body}}`, and every request is recorded (`requestsTo(record, fn, action)`).
- **Storage (gap):** `/storage/v1/**` always answers `200 {}`, with no fixture hook and no body capture beyond `postData`, which is JSON-parsed or else a raw string.
  - For media upload tests, either add `fixtures.storage(entry, request)` to the harness (recommended: a 3-line change that keeps the `inflight` accounting that `settle()` relies on), or register `context.route(`${SUPABASE}/storage/v1/**`)` after `launchAtlas`. Playwright runs later-registered routes first, but those bypass `settle()`'s inflight counter.
  - Signed upload URLs pointing at another origin need their own `context.route`.
- **MIME map (question answered):** `.webm: video/webm` and `.mp4: video/mp4` are already in `MIME`, so the harness can serve mp4 from `apps/web`. That map only applies to static files under `apps/web`. Fixture videos go through `page.setInputFiles({ name, mimeType: 'video/mp4', buffer })` or a `functions`/storage route whose `contentType` you set yourself.
- **Clock:** frozen at `HARNESS_NOW = 2026-09-24T14:00Z` (Thursday; Reykjavík is UTC+0). `timezoneId` is per launch. `controlTimers: true` with `advanceTimers(page, ms)` covers retry and backoff. `settle`/`until` replace sleeps.
- **Users:** only `USERS.admin` and `USERS.bartender` exist. Tests define `MANAGER` locally (`settings.browser.test.mjs:353`, `workflow-integrity.browser.test.mjs:12`); copy that.
- **Hygiene rules** (`tests/node/browser-suite-hygiene.test.js`):
  - no `waitForTimeout`;
  - no `Date.now()` / `new Date()` in Node-side browser files, except in lines containing `window.`, `document.` or `page.evaluate`;
  - the harness default clock is pinned by regex, so changing the `launchAtlas` signature line breaks that test.
- **Large files:** build them inside the page (`atlas-ai.browser.test.mjs:905-925`, `DataTransfer` + `input.files` + a `change` event) rather than pushing MBs through `setInputFiles`.
- **Phone:** the idiom is `noHorizontalScroll(page)` = `scrollWidth <= innerWidth + 1` (teamc), with `PHONE = {390, 844}`.

### 1.4 SQL previews
- **Pattern:** `begin; create temp table sNN(test_name text primary key, passed boolean) on commit drop;`, then seed `auth.users`/`profiles`, switch into the browser role with `set local role authenticated` + `set_config('request.jwt.claim.sub', …)`, run `insert … select '<name>', <bool>`, emit a final `jsonb_build_object('<suite>', 'passed'|'failed', counts, tests)`, then `rollback;`.
- **Runner:** `verify_s90_workflow_integrity_previews.sh` greps `^{"tests` or `^{` and requires `": "passed"`. CI runs each runner as a step in `.github/workflows/migration-replay.yml` (image `postgres:17`, `PGPASSWORD=postgres`), so S94 needs a new step.
- **Replay stubs** (`verify_full_migration_replay.sh` bootstrap) cover the `auth`, `storage` (buckets/objects, `foldername`/`filename`/`extension`), `vault`, `realtime` and `extensions` schemas. They do not cover `pg_cron` or `pg_net`, which are also not available locally. If the S94 migration schedules the worker with `cron.schedule`/`net.http_post`, either put the schedule in a separate non-replayed ops step, or guard it with `if exists (select 1 from pg_extension where extname='pg_cron')`. A python contract test should pin whichever choice is made.
- **Storage policies:** the preview pattern (`verify_s87_atlas_media_policies_preview.sql`) grants `storage.objects` to `authenticated` inside the transaction, because the bootstrap does not. The S94 media bucket preview should follow it, including the bucket's `file_size_limit` and `allowed_mime_types` rows.

---

## 2. Concurrency: proving there is no double-claim under SKIP LOCKED (proven locally)

**Environment:** PostgreSQL 16.13 locally (it was stopped; `service postgresql start` fixed that). `pg_available_extensions` lists `dblink 1.2` and `postgres_fdw`; `pg_cron` and `pg_net` are absent. The CI image `postgres:17` ships contrib, so dblink is available there too.

**Probe run on scratch DB `s94_scratch`** (created and dropped by me):
- Two dblink sessions `a` and `b` each called `claim(worker, n)` (`update … where id in (select … for update skip locked limit n) returning id`).
  - **Held-lock case:** A runs `begin`, claims 10 and does not commit. B then claims 10 and gets ids 11–20. B skipped A's rows and did not block. Result: `double_claimed = 0`.
  - **True race:** `dblink_send_query` on both, then `dblink_get_result`, got 30 + 20 = 50 rows claimed, all 50 `running`, `double_claimed = 0`.
- **Conninfo** that works both locally and in CI without a password: `'dbname=' || current_database() || ' user=postgres'`. That is a unix socket, which is peer auth locally and trust inside the docker image. TCP `host=127.0.0.1` needs `password=` in the conninfo.

**Key caveat:** dblink sessions are separate transactions and cannot see a preview's uncommitted `begin…rollback` fixtures. So the concurrency proof must commit its data. Recommended method:

- **`scripts/verify_s94_publish_concurrency.sh`:**
  - `createdb s94_concurrency -T vaos_replay` (a template clone takes about 0.2s locally and needs no other connections to `vaos_replay`; the runners are sequential, so that holds);
  - `psql -d s94_concurrency -f scripts/verify_s94_publish_concurrency.sql`;
  - `dropdb` in a `trap`.
- **`verify_s94_publish_concurrency.sql`** (committed fixtures in the throwaway DB):
  1. `create extension dblink;` then seed N = 200 due, approved targets across three providers.
  2. **Deterministic interleave:** session A runs `begin` + `select * from public.<claim_rpc>(worker=>'A', limit=>50)` and holds the transaction. Session B claims while A is open, and must return disjoint ids without blocking. Wrap it in `set lock_timeout='2s'` so a regression to plain `FOR UPDATE` fails fast instead of hanging.
  3. **Race:** `dblink_send_query` to 4 sessions × `claim(limit 80)` in a loop until empty. Then assert:
     - `count(*) = N`;
     - `count(distinct target_id) = N` across the attempt ledger;
     - no target has two attempts with the same `attempt_no`;
     - the `unique(target_id, attempt_no)` constraint exists.
  4. **Duplicate worker execution after a crash:** simulate worker A claiming and dying (a lease expires: set `lease_expires_at = now() - interval '1s'`). A re-claim by B increments `attempt_no`, and A's late `complete(target, attempt_no = 1, lease_token)` is refused (stale lease token → no-op or SQLSTATE), so the target is published once.
  5. **Widening knob, if needed:** the claim RPC can be exercised with `pg_advisory_xact_lock` held by the test in session C to force ordering. `pg_sleep` is only allowed inside the claim transaction in the held-lock case, never as a wait for results.
  6. Emit the same `{"s94_concurrency":"passed",…}` verdict line so the existing runner grep works.
- **Node alternative (not recommended for CI):** `pg` exists only at `/tmp/claude-0/nlcli/node_modules/pg` and is not a repo dependency. A Node test could spawn two `psql` child processes, but dblink keeps everything inside the SQL preview runner that CI already has.

---

## 3. Media fixtures (offline, deterministic)

- **PNG:** reuse the 1×1 base64 already in `atlas-ai.browser.test.mjs:241` (`iVBORw0KGgo…`). PIL 12.3.0 is present if a larger PNG is needed (`Image.new('RGB',(8,8)).save(b,'PNG')` gives 77 B, `89504e47`).
- **JPEG:** PIL produces an 8×8 JPEG of 633 B starting `ffd8ffe0`. Commit it as a base64 constant in `tests/node/helpers/media-fixtures.mjs`, which avoids a PIL dependency in CI.
- **MP4:**
  - **Structural (for sniffing and server validation):** hand-build the bytes. `00000018 66747970 69736f6d 00000200 69736f6d 6d703431` is an ftyp box (`isom`), followed by an 8-byte `free` box and a small `mdat`. That is enough for magic-byte and MIME checks.
  - **Real playable:** local Playwright Chromium 141 records a canvas with `MediaRecorder` as `video/mp4` (`isTypeSupported('video/mp4') = true`, `'video/mp4;codecs=avc1' = false`, no H.264). The result was 977 B with header `…6674797069736f6d` (ftyp isom). Generate it once with a throwaway script (probe at `scratchpad/s94/mr.mjs`) and commit it base64. Do not generate it at test time.
  - **Caveat:** Playwright Chromium lacks H.264, so browser tests must not depend on decoding real phone H.264 MP4s. Assert the upload request, MIME, size and the server-returned poster or metadata, not `video.readyState`.
- **Refusal fixtures:**
  - a `.exe`/`application/x-msdownload` file;
  - a file named `.jpg` whose bytes are PDF (`%PDF`), for the magic-byte vs declared-type mismatch;
  - an SVG (script-capable; refused);
  - oversized files built in-page (`Uint8Array(limit+1)` with the correct magic), per the atlas-ai 11 MB pattern.

---

## 4. Provider mock design (Node worker tests)

**File:** `tests/node/helpers/social-provider-fakes.mjs`.

```js
export function createProviderFakes({ now, script = {} }) -> {
  fetchImpl,          // inject as the worker's fetch
  calls,              // [{ provider, op, url, method, body, headers }] (the Authorization header is redacted)
  published,          // Map provider -> [{ externalId, payloadHash }]; the "real world" side effects
  tokens,             // current valid access token per provider (rotates on refresh)
  setScript(provider, op, steps)
}
```

- **Routing:**
  - Meta covers `graph.facebook.com/vXX.X/…` (IG `/{ig-user}/media`, `/{ig-user}/media_publish`, `GET /{container}?fields=status_code`; FB `/{page}/photos`, `/{page}/feed`, `/{page}/videos`).
  - TikTok covers `open.tiktokapis.com/v2/post/publish/creator_info/query/`, `…/video/init/`, `…/content/init/` (photo), `…/status/fetch/` and `/v2/oauth/token/`.
  - Google covers `oauth2.googleapis.com/token`, `mybusinessbusinessinformation.googleapis.com/v1/accounts/*/locations` and `mybusiness.googleapis.com/v4/accounts/*/locations/*/localPosts`.
  - Anything else throws `Unexpected provider request`, as in the stock-truth backend.
- **Step vocabulary** (a queue per `provider:op`; the last step repeats):
  - `ok(body?)`: a realistic success. The IG container returns `{id}`, publish returns `{id}` and records it in `published`. The TikTok init returns `{data:{publish_id}, error:{code:'ok'}}`. GBP returns `{name, state:'LIVE'}`.
  - `transient(status, body, {retryAfter})`: 429/500/502/503. Meta `{error:{code:4|17|32|613|1|2, is_transient:true}}`, TikTok `rate_limit_exceeded`, Google `RESOURCE_EXHAUSTED`/`UNAVAILABLE`.
  - `permanent(status, body)`: Meta `code 100` (invalid param) or `368`, TikTok `spam_risk_too_many_posts`/`privacy_level_option_mismatch`/`url_ownership_unverified`, Google `INVALID_ARGUMENT`/`PERMISSION_DENIED`.
  - `authExpired()`: Meta `{error:{type:'OAuthException', code:190, error_subcode:463}}` 401, TikTok `access_token_invalid` 401, Google 401 `UNAUTHENTICATED`.
  - `refreshInvalidGrant()`: the token endpoint returns `400 {error:'invalid_grant'}`, which must lead to `reauthorization_required`.
  - `lostResponse()`: performs the side effect (records in `published`), then throws `new TypeError('fetch failed')`.
  - `timeout()`: rejects with `DOMException('…','TimeoutError')`.
  - `processing(n)`: a status poll returns IN_PROGRESS / `PROCESSING_DOWNLOAD` n times, then FINISHED / `PUBLISH_COMPLETE`.
  - `unaudited()`: the TikTok `creator_info` returns `privacy_level_options:['SELF_ONLY']`. Init with any other privacy level returns `unaudited_client_can_only_post_to_private_accounts`.
  - `noLocations()`: the GBP locations list is `{}`, or the stored location name returns 404.
  - `singleUseContainer`: publishing an IG creation_id twice returns an "already published" error, and a `status_code` poll then reports `PUBLISHED`. Provider agents must confirm the exact codes against Meta and TikTok docs; the fakes centralise them in one table so a doc correction touches one place.
- **Leak probe:** every fake echoes the bearer token inside error `message` bodies (as the integrations test does for Google), so `assertNoLeak` proves the worker sanitises provider bodies before storing or returning them.
- **Worker test backend:** `fakePublishingDb()` mirrors the SQL claim/complete/fail/needs_attention/notify RPCs, as `fakeDatabase()` does in the integrations test. Also inject `now()`, `random()` (for jitter) and `sleep` (a no-op recorder). Backoff is asserted on the stored `next_attempt_at`, never by waiting.
- **Credentials:** the worker reads them through the existing `atlas_integration_read_credential` RPC + `decryptJson(KEK)`. The fake stores real AES-GCM ciphertext made with `encryptJson` from `oauth-core.mjs`, so decrypt paths are exercised for real.

---

## 5. Recommended code shape (to make the above testable)

- Put the publishing worker in `supabase/functions/<publisher>/worker.mjs` exporting `createPublishingWorker({ env, fetchImpl, rpc, now, random })`, with provider adapters in `adapters/{meta,tiktok,google}.mjs`, each exporting a pure `classifyError(status, body) -> 'transient'|'permanent'|'auth'|'reauth'`. `index.ts` stays a thin `Deno.serve` shell.
- Put new marketing gateway actions (media upload intent, attach, reorder, remove, schedule, publish-now, cancel) either in `handler.mjs` DI form, or leave them in `index.ts` and test them via `loadEdgeFunction`.
- The worker secret is a header compared in constant time. The worker function sets `verify_jwt = false` in `supabase/config.toml`, and a python contract test pins that.

---

## 6. Scenario → test map

Layers used below:
- **SQL** = `scripts/verify_s94_marketing_publishing_preview.sql` (rolled back);
- **CONC** = `scripts/verify_s94_publish_concurrency.sql` (template clone);
- **WRK** = `tests/node/marketing-publishing-worker-s94.test.js` (worker + provider fakes);
- **API** = `tests/node/marketing-publishing-api-s94.test.js` (gateway via DI or `loadEdgeFunction`);
- **SRC** = `tests/node/marketing-publishing-contract-s94.test.js` (static source) plus `tests/python/test_marketing_publishing_s94_contract.py` (migration/config/manifest);
- **BR** = `tests/browser/marketing-publishing.browser.test.mjs` + `marketing-publishing-fixtures.mjs`.

| # | Scenario | Layers | Assertion style |
|---|---|---|---|
| M1 | Image upload | API, SQL, BR | API: the upload intent returns a signed upload URL scoped to `marketing/<post>/<uuid>.<ext>` with a TTL ≤ N min, and `media` row status is `pending`. Finalize checks magic bytes, then status is `ready` with width/height/size. SQL: the storage policy lets a manager insert only under the prefix; the bucket's `allowed_mime_types`/`file_size_limit` equal the spec. BR: `setInputFiles` JPEG → `requestsTo(...,'media-intent')` with `{mime:'image/jpeg', bytes:633}`; the storage PUT is captured by the storage hook; a thumbnail tile appears. |
| M2 | Video upload | API, BR | The same flow with a committed mp4 fixture; `mime: video/mp4`; the duration/size cap is enforced server-side; BR shows a video tile without decoding (see the section 3 caveat). |
| M3 | Multi-image collection | API, SQL, BR | Three images give `post_media` positions 0..2. SQL: `unique(post_id, position)` and a max-count check (e.g. 10, IG carousel). WRK: an IG carousel creates 3 child containers + 1 CAROUSEL container + 1 publish; FB creates `photos?published=false` ×3 + a feed post with `attached_media`. |
| M4 | Reorder collection | API, SQL, BR | The `reorder` action with an explicit id list is atomic: an id list that is not a permutation is refused (400); positions persist. BR: a keyboard/drag reorder sends the ordered ids and a rerender shows the order. A reorder after approval is an edit, so see M12. |
| M5 | Attach existing media | API, SQL | Attaching a `ready` media id from the library links it without copying; attaching another venue's or a deleted/pending media is refused; there are no duplicate links. |
| M6 | Remove media | API, SQL, WRK | Removing unlinks and compacts positions. The storage object is deleted only when no other post references it (SQL count). WRK: a post whose media was removed after claim fails permanently with `media_missing`, not a provider call. |
| M7 | Schedule future post | API, SQL, BR | `scheduled_for` stored UTC from Reykjavík wall time. The claim RPC does not return it before `scheduled_for` (SQL with `now()` shifted via a parameter `p_now`, or a seeded past/future pair). BR: the editor and calendar show venue time. |
| M8 | Publish now uses the same path | API, SQL, WRK | "Publish now" sets `scheduled_for = now()` on the same targets and the worker picks it up through the same claim (SRC: no direct provider call from the gateway; the regex forbids provider hosts in the gateway source). WRK: identical adapter calls for scheduled vs now. |
| M9 | Approval | SQL, API, BR | Only admin/manager decide (bartender gets 42501/403). Approval records `approved_revision_hash`. The claim returns only targets whose post is `approved` and whose hash equals the current revision hash. BR: extend the existing teamc decide test. |
| M10 | Rejected never publishes | SQL, WRK | Seed a rejected post with due targets, then `claim()` returns 0 rows for it. WRK: `fetchImpl` records zero provider calls. |
| M11 | Cancelled never publishes | SQL, CONC, WRK | Cancelling after claim but before the provider call is covered two ways. SQL: cancel sets targets `cancelled`, and the claim skips them. WRK: the worker re-checks via `begin_attempt` (the RPC returns `proceed:false`) and makes no provider call. CONC: cancel concurrent with claim ends either cancelled or claimed, never both published and cancelled. |
| M12 | Edited after approval requires re-approval | SQL, API, BR | Editing caption, media, order or channels after approval changes the revision hash, so status returns to `pending_approval` and the claim returns 0. Schedule-time-only edits follow the product decision; pin whichever it is. BR: a banner "Needs approval again". |
| M13 | Disconnected provider | WRK, SQL, BR | A target for a provider with `status <> 'connected'` goes to `needs_attention` with reason `not_connected`, 0 provider calls, and a notification row. BR: the channel chip is disabled with a link to `#settings/integrations`. |
| M14 | One provider succeeds, another fails | WRK, SQL | Per-target status: IG `published` with `external_id`, TikTok `failed`/`retrying`. The post-level rollup is `partially_published`, and the success is never retried (the next claim excludes published targets). |
| M15 | Temporary error: retry with backoff | WRK, SQL | A `transient(429,{retryAfter:120})` then `ok` script. Assert `next_attempt_at = now + max(retryAfter, base·2^n ± jitter)` with injected `random`, `attempt_no` increments, and a cap after K attempts leads to `needs_attention`. SQL: the claim respects `next_attempt_at`. BR (UI retry display): `controlTimers` + `advanceTimers`. |
| M16 | Permanent error → needs_attention + notification | WRK, SQL | `permanent(400)` gives exactly 1 provider call, status `needs_attention`, a sanitised `last_error` (`assertNoLeak`), and 1 notification per manager/admin (and 0 for bartenders). SQL: a dedupe key prevents a second notification for the same attempt. |
| M17 | Duplicate worker execution | CONC, WRK | CONC steps 2–4 in section 2. WRK: two worker invocations sharing one `fakePublishingDb` with `Promise.all` give `published` length 1 per target. |
| M18 | Lost-response idempotency | WRK | `lostResponse()` on IG `media_publish`, then a retry. The worker persisted `container_id` before publish and polls status instead of re-publishing, so `published.get('instagram').length === 1`. TikTok: `publish_id` persisted after init, and the retry polls `status/fetch`. GBP: before re-POST, list localPosts and match the Atlas marker. Also cover the retry-after-lost-response where the provider really did not post. |
| M19 | Token expiration and refresh | WRK | `authExpired()` then refresh `ok`, then retry `ok`. That is one refresh call, the new token is stored encrypted (credential RPC called with new ciphertext; the plaintext never appears in `calls` bodies to the DB), and the post is published. A pre-emptive refresh when `access_expires_at < now + 5 min` makes no failing call first. |
| M20 | Reauthorization state | WRK, SQL, BR | `refreshInvalidGrant()` sets the connection to `expired`/`reauthorization_required` (via `atlas_integration_record_result p_needs_reauthorization`); targets go to `needs_attention: reauthorize`; no retry loop. BR: a "Reconnect" CTA. |
| M21 | TikTok private-only / unaudited | WRK, API, BR | `unaudited()`: the worker reads `creator_info`. If only `SELF_ONLY` is offered, the post goes with `privacy_level: 'SELF_ONLY'` only if the draft chose private, otherwise `needs_attention: tiktok_private_only` with no init call. API: the snapshot exposes `tiktok.private_only: true`. BR: the editor shows the private-only notice and locks visibility. |
| M22 | GBP location missing | WRK, API, BR | `noLocations()` gives `needs_attention: gbp_location_missing`, 0 localPosts calls. API refuses scheduling GBP without a stored location (400). BR: an inline message links to Settings. GBP video is refused at validation. |
| M23 | Month calendar | BR, API | `#marketing/calendar` month grid for Sep 2026 (`HARNESS_NOW`): posts on correct days, month navigation sends `from/to` = venue month bounds (`c.monthKey`), and a status badge per post (scheduled / published / needs attention). |
| M24 | Reykjavík time in other browser zones | BR, SRC | Launch with `timezoneId` `America/New_York`, `Asia/Tokyo` and `Pacific/Kiritimati` (UTC+14, crosses the date line). Entering `2026-10-01T18:00` gives payload `2026-10-01T18:00:00.000Z`; the calendar day equals the Reykjavík day; a post at 23:30 UTC lands on the Reykjavík date. SRC: the existing `getTimezoneOffset` ban extends to new files. |
| M25 | Mobile layout | BR | At 390×844 and 360×740: `noHorizontalScroll` on overview, calendar, editor with 10 media and the post detail. Bottom actions: the primary action bar's `getBoundingClientRect().bottom` is within 1px of `innerHeight` (or `visualViewport`), `position: sticky/fixed`, targets ≥ 44px, and the bar stays visible after scrolling the sheet. The CSS goes into `@layer atlas.modules` and must pass `css-hygiene-s88` (ratchet baseline `tests/node/css-hygiene-s88.baseline.json`; do not grow counts). |
| M26 | Role checks server-side | SQL, API, BR | SQL matrix (admin/manager/bartender/deactivated manager/anon) × (upload intent, attach, reorder, approve, publish-now, cancel, read snapshot, claim/complete worker RPCs). Browser roles get no execute on worker RPCs (`has_function_privilege`). API: a bartender approve/publish returns 403 with 0 RPC writes (fake records). BR: the bartender sees no approve/publish controls, but assertions rely on server refusals, not hidden buttons. |
| SEC-1 | No token in responses or events | API, WRK, SQL | `assertNoLeak` over every API response and every `fakePublishingDb` write (events, `last_error`, notification bodies). SQL: `pg_temp.s94_has_secret_keys(snapshot)` = false for snapshot, events and notification payloads (copy from S88). SRC: the browser bundle has no `access_token`/provider hosts (extend `secret-scan-s89` if needed). |
| SEC-2 | Signed URL expiry | API, SQL | The intent returns an `expires_in ≤ TTL` that the fake storage client received. Finalize after expiry (`now` advanced) is refused, and the pending media is garbage-collectable (SQL: the purge query selects expired pending rows). Download/preview URLs are short-lived signed URLs, not public buckets (SQL: `storage.buckets.public = false`). |
| SEC-3 | File type/size refusal | API, SQL, BR | Declared-type allowlist, magic-byte check (a PDF-bytes `.jpg` is refused), SVG refused, oversize refused. Assert on both the intent (declared size) and finalize (actual object size). SQL: bucket limits. BR: in-page oversized file shows the error, and no intent request is sent. |
| SEC-4 | Worker secret required | WRK/API | Covers: no header → 401; a wrong header of the same length → 401; an empty expected env → 500 "not configured" (never accept an empty secret); and the right header → 200. SRC: constant-time compare (`timingSafeEqual` or a manual XOR loop; not `!==`). No CORS `access-control-allow-origin` for the worker route. |

**Cross-cutting hygiene obligations:**
- Add the new script cache keys to `index.html`/`config.js` and extend `shell-contract-s88` "changed scripts carry the … cache key".
- Keep `browser-suite-hygiene` passing (no sleeps, no Node-side wall clock).
- Add a CI step to `migration-replay.yml` for the S94 previews and the concurrency runner.
- Python contract tests pin `config.toml` `verify_jwt` for new functions, plus any release or runtime manifest lists that enumerate functions (`scripts/build_s3x_*` reference function names; check `test_s37_isolation_runtime.py`).

---

## 7. Commands

```sh
cd /home/user/-V-OS-/.claude/worktrees/s94
node --test tests/node/marketing-publishing-*.test.js tests/node/browser-suite-hygiene.test.js tests/node/css-hygiene-s88.test.js tests/node/shell-contract-s88.test.js
python -m unittest tests.python.test_marketing_publishing_s94_contract -v
ATLAS_BROWSER_LIBS=/tmp/claude-0/harness/node_modules node --test tests/browser/marketing-publishing.browser.test.mjs tests/browser/teamc.browser.test.mjs
service postgresql start   # if pg_isready fails
export PGPASSWORD=postgres PGHOST=127.0.0.1 PGUSER=postgres
bash scripts/verify_full_migration_replay.sh
bash scripts/verify_s94_marketing_previews.sh      # rolled-back preview(s)
bash scripts/verify_s94_publish_concurrency.sh     # template clone + dblink, dropped in trap
```
