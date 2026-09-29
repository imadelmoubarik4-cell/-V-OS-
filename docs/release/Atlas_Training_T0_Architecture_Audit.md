# Atlas Training — T0 Architecture Audit & Implementation Contract

_Branch: `claude/atlas-training-mvp`. Base: `main` @ `01496fd4`. Read‑only audit of the
existing codebase; no production access used beyond read‑only inspection. This document is
both the required T0 audit and the frozen contract the implementation is built against._

---

## Part A — Existing architecture (the 16 audit points)

### 1. Knowledge tables / functions
All Knowledge data lives in schema **`atlas_private`** (checkpoint G,
`supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql`): `knowledge_settings`,
`knowledge_categories`, `knowledge_articles`, `knowledge_article_versions`,
`knowledge_sources`, `knowledge_task_links`, `knowledge_reads`, `knowledge_acknowledgements`,
`knowledge_events`. Every table has RLS on with a single `for all to service_role` policy;
`revoke all` from `public, anon, authenticated`. Access is exclusively through the
**`atlas-knowledge` Edge Function** (`supabase/functions/atlas-knowledge/index.ts`), which is
the sole authorization boundary — the gateway pattern.

### 2. Article / version publication lifecycle
`knowledge_articles(status in draft|published|retired, current_version_id, draft_version_id,
current_version, required, target_roles text[], article_type, category_id)`.
`knowledge_article_versions(version_number, state in draft|published|superseded, title,
summary, content, content_format, published_at/by)`. Partial unique indexes enforce **one
draft** and **one published** version per article. Publishing supersedes the current
published version, flips the draft to published, and stamps `published_at`. **Versions are
immutable once published** — this is exactly the model Training reuses.
`article_type` already includes **`'training'`**; category `training-onboarding` already seeded.

### 3. Role visibility rules
Roles: `admin, manager, bartender, viewer` (`admin`/`manager` are managers). Central rule
`atlas_private.knowledge_article_visible(article, actor_role, is_manager)`:
managers see everything; staff see only `status='published'` articles whose `target_roles`
contains `'all'` or the actor's role. Enforced in SQL and again in the Edge Function.

### 4. Acknowledgements / read tracking
`knowledge_reads` (PK version_id+user_id, read_count) and `knowledge_acknowledgements`
(PK version_id+user_id, bound to the exact version, only for `required` articles on the
current published version). Both are version‑specific — the same per‑version pattern Training
completion uses.

### 5. Onboarding bridge
`public.onboarding_tasks` / `public.onboarding_progress` (production tables; S96
`20261010090000_...` restricts writes to managers, `completed_by = auth.uid()`).
`atlas_private.knowledge_task_links(article_id, onboarding_task_id, required_for_task)` links
an article to an onboarding task (onboarding_task_id is a bare uuid, validated in the function
against live production tasks — not a cross‑project FK). A training lesson is an article, so
this bridge already covers Training with no new engine.

### 6. Team integration
`knowledge_publish` best‑effort posts a Team announcement via
`atlas_private.team_messages_post_system(link_type='knowledge_article')`. The training block in
`knowledge_snapshot` already folds onboarding tasks + per‑profile team progress for managers.

### 7. Operations checklist architecture
`apps/web/assets/js/operations.js` + `atlas-operations-checkpoint-a`; checklist items are
server‑backed (`{id,label,section,required,completed,...}`). Clean "Watch how" hook point is
`itemMarkup()` — needs the server to attach a `lesson_id` to items (not present today).

### 8. Search
Server‑side Postgres full‑text (tsvector, `'simple'` config, title=A/summary=B/content=C),
`20260926103000_s88_knowledge_search.sql`, exposed as `public.atlas_knowledge_search`
(service_role only) and re‑guarded in the function: staff match only current published,
role‑visible versions. Training lessons are Knowledge articles, so they are already indexed;
no draft leaks to staff.

### 9. Activity / audit events
`atlas_private.knowledge_events` (append‑only since S96 `20261010096000_...`: update/delete/
truncate revoked, triggers `s96_append_only` / `s96_append_only_no_truncate`). `event_type`
is a CHECK list of nine knowledge events.

### 10. Storage usage / buckets / policies
Buckets created in migrations: `atlas-media` (public, images), `atlas-imports`,
`atlas-profile-photos`, `atlas-ai-media`, `atlas-accounting-documents`, and
**`atlas-marketing-media`** (private, **1 GiB**, allows `video/mp4`,`video/quicktime`).
The recommended private pattern (accounting, ai‑media, marketing‑media): **private bucket with
NO `storage.objects` policy** — the browser gets no direct object access; the Edge Function
(service role) uploads and mints short‑lived signed URLs after checking authorization.
`20261010094000_s96_storage_drop_unused_update_policies.sql` deliberately removed permissive
UPDATE policies — do not add a storage UPDATE policy.

### 11. Auth / profile authorization helpers
`supabase/functions/_shared/auth.mjs`: `resolveActor(request, env, fetch, opts)` verifies the
JWT against Auth, reads the caller's own profile (RLS), enforces active + known role + the S96
privileged‑MFA (aal2) gate; returns `{userId, role, active, label, token, ...}`. `actorLabel`
never exposes an email. SQL helpers `private.is_manager_or_admin()`,
`private.current_profile_role()` (S96 MFA‑gated), `private.is_self_or_manager(uuid)`.

### 12. Edge Function patterns
`verify_jwt=false` in `supabase/config.toml` (the handler validates the JWT itself, since Auth
is the production project while data may live on an isolated branch). CORS constant,
`jsonResponse` (+ `x-content-type-options`, per‑function version header), `class ApiError`,
`?action=` dispatch, `MAX_BODY_BYTES` cap, `Set`‑based enum allowlists, service‑role RPC calls
via `POST {SUPABASE_URL}/rest/v1/rpc/<name>`. **Error redaction**: only Atlas‑authored SQLSTATEs
(`P0001,42501,22023,P0002,55000,23514`) with no schema words reach the browser; everything else
becomes a fixed fallback (accounting uses `hint='atlas:<code>'` → safe message map). No secrets
or tokens logged. Storage via raw REST with the service key: upload
`POST /storage/v1/object/<bucket>/<path>`; sign `POST /storage/v1/object/sign/<bucket>/<path>`
`{expiresIn}`; signed‑upload token `POST /storage/v1/object/upload/sign/<bucket>/<path>`;
ranged read `GET /storage/v1/object/authenticated/<bucket>/<path>`; resumable TUS at
`https://<ref>.storage.supabase.co/storage/v1/upload/resumable`.

### 13. Frontend routing conventions
Hash router in `apps/web/assets/js/atlas-shell.js` (`ROUTES`, `parseRoute`, `href`,
`show`). Knowledge resolver at `ROUTES.knowledge` currently **drops** a second path segment, so
`#knowledge/training/<id>` collapses to the tab — must be extended to carry a `lesson` param.
Views register via `shell.registerView('knowledge', {root,title,render,onHide})`;
`render(params)` reads `params.section`/`params.article`. Config is the committed global
`window.VABAR_CONFIG` in `apps/web/config.js`; the one shared client is `window.atlasSupabase`
(created in `atlas-app.js`). Knowledge UI (`knowledge-workspace.js`) calls its function through a
local `api(action,{params,method,body})` helper (`?action=` + `Bearer` JWT), applies payloads
via `applyPayload`, sanitizes with local `escapeHtml` / `renderMarkdown` (escape‑first, then a
whitelist — no third‑party markdown/sanitizer) / `safeHttpUrl`, and uses `window.AtlasModal`
for sheets/dialogs.

### 14. Test patterns
`package.json`: `test:node` (`node --test tests/node/*.test.js`), `test:browser`
(`node --test tests/browser/*.browser.test.mjs`, Playwright), `test:python`
(`unittest discover tests/python`), `test:ai` (deno). Browser harness
(`tests/browser/harness.mjs`) serves the real `apps/web` and **mocks all Supabase traffic** via
`fixtures.tables/rpc/functions/storage`; `USERS` defines admin/bartender; `{ skip }` guards run
without Playwright. SQL integrity tests in `tests/sql/`. CI: `atlas-verify.yml`
(contracts + browser), `migration-replay.yml` (Postgres 17 replay + S9x acceptance). New
browser tests follow the S97 `inventory-locations` + `inventory-fixtures` pattern.

### 15. Reusable architecture (Training reuses, does not replace)
Knowledge articles/versions (immutable lifecycle, SOP content), categories, `target_roles`,
`required`, search, acknowledgements/reads, `knowledge_task_links` (onboarding), `knowledge_events`
(audit), the visibility rule, `_shared/auth.mjs`, the private‑bucket + signed‑URL storage
pattern, the S96 hardening conventions, the browser harness + fixture pattern.

### 16. Gaps requiring new implementation
Per‑version **video/media**, **chapters**, structured **procedure steps**, per‑user **progress /
resume**, explicit **completion evidence**, a **private training‑video bucket**, the **lesson
player** UI + `#knowledge/training/<id>` route, a **manager completion view**, and a thin
**`atlas-training` gateway** for media upload/sign + training authoring/progress.

---

## Part B — Frozen implementation contract

### B1. Storage
Private bucket **`atlas-training-videos`** (NO `storage.objects` policy), `video/mp4`,
`video/webm`, `video/quicktime`; size limit 2 GiB. Object path
`lessons/<article_id>/<media_asset_id>.<ext>` — generated, immutable, never overwritten for a
published version. Playback only via server‑minted signed URLs (300 s). Upload manager/admin
only, content type sniffed from bytes, size enforced.

### B2. New schema (`atlas_private`, migration `s98_training`)
- `training_media_assets(id, bucket, storage_path unique, original_filename, mime_type, bytes,
  duration_seconds, width, height, upload_status[pending|stored|failed], created_by,
  created_by_label, created_at)` — storage_path CHECK regex.
- `training_lesson_versions(version_id pk → knowledge_article_versions on delete cascade,
  article_id, media_asset_id → training_media_assets, estimated_minutes, difficulty
  [easy|medium|hard|null], completion_rule[explicit], requires_video bool, created_at,
  updated_at)` — the per‑immutable‑version training payload.
- `training_chapters(id, version_id → knowledge_article_versions cascade, start_seconds int
  >=0, title, sort_order)`.
- `training_steps(id, version_id cascade, label, sort_order)`.
- `training_progress(id, user_id, article_id, version_id, started_at, last_opened_at,
  last_video_position_seconds int default 0 >=0, completion_state[in_progress|completed]
  default in_progress, completed_at, user_role, created_at, updated_at, unique(user_id,
  version_id))` — the durable resume + completion record; per‑version so v1 survives v2.
- All tables: RLS on, single `for all to service_role` policy, `revoke all from public, anon,
  authenticated`, `grant all to service_role`. `training_media_assets` + `training_progress`
  completion writes are audited via `knowledge_events` (event_type CHECK extended with
  `training_media_uploaded, training_media_replaced, training_started, training_completed,
  training_chapters_saved`), which stays append‑only.

### B3. RPCs (`public.atlas_training_*`, SECURITY DEFINER, `search_path=''`, revoke from
public/anon/authenticated, **grant execute to service_role only** — service‑role model, so the
S96 browser‑RPC allowlist `verify_s96_rls_ownership.sql` is NOT touched)
- `atlas_training_snapshot(p_actor_id, p_actor_role)` — staff/manager training home data.
- `atlas_training_lesson(p_article_id, p_actor_id, p_actor_role, p_prefer_draft)` — one lesson +
  chosen version + chapters + steps + media descriptor (no signed URL) + progress.
- `atlas_training_save_draft(...)` — reuses `atlas_private.knowledge_save_draft` for the article/
  version, then upserts `training_lesson_versions` + replaces chapters/steps for the draft
  version. Manager‑gated.
- `atlas_training_attach_media(p_version_id, p_media_asset_id, ...)` — link an uploaded asset to
  the **draft** version only (published media immutable).
- `atlas_training_register_media(...)` — insert a `training_media_assets` row (pending→stored).
- `atlas_training_publish(p_article_id, ...)` — reuses `atlas_private.knowledge_publish`; freezes
  the training payload on the now‑published version.
- `atlas_training_start(p_article_id, p_version_id, p_actor_id, p_actor_role)` and
  `atlas_training_save_progress(p_version_id, p_position_seconds, ...)` — staff, own record only.
- `atlas_training_complete(p_article_id, p_version_id, p_actor_id, p_actor_role)` — explicit,
  idempotent, version‑specific, only for a published version the actor may access.
- `atlas_training_completion_report(p_article_id, p_actor_id, p_actor_role)` — manager only.
Every RPC re‑checks the actor via a local `atlas_private.training_require_actor(p_actor_id,
p_actor_role)` (mirrors `ai_require_actor`) and re‑checks manager role for authoring/report.

### B4. Edge Function `atlas-training` (`index.ts` + `handler.mjs`, `verify_jwt=false`)
Actions: `snapshot`, `lesson` (GET); `upload-url` / `register-media` / `save-draft` /
`attach-media` / `publish` / `retire` (manager POST); `playback` (POST → signed URL after
visibility check), `start` / `progress` / `complete` (staff POST); `report` (manager GET).
Copies CORS, `jsonResponse`, `ApiError`, `mapRpcError`/redaction, and the storage service
(`upload`, `sign`, `remove`, `signUpload`) from `atlas-accounting`/`atlas-marketing-media`.
`config.js` gains `TRAINING_API`.

### B5. Frontend
Extend `ROUTES.knowledge` to carry `#knowledge/training/<lessonId>`; add `loadLesson` +
`lessonMarkup` (player: video → chapters → SOP → steps → explicit completion) and a manager
authoring sheet + completion view inside `knowledge-workspace.js`; new CSS under
`@layer atlas.modules` in `knowledge-workspace.css`; reuse `renderMarkdown`/`escapeHtml`/
`safeHttpUrl`/`AtlasModal`; phone sticky `.kn-bar`. Playback uses a blob URL from the signed
URL to satisfy the existing `media-src 'self' blob:` CSP (no production CSP change required).

### B6. Preview / test environment
Non‑production **Supabase preview branch** (isolated DB + Storage + functions + keys) as the
real backend for end‑to‑end proof (real MP4 upload → signed playback → completion). Netlify
Deploy Preview serves the UI. Production Supabase is never modified.

### B7. Security invariants (verified by the attack‑test matrix)
Drafts manager‑only; published restricted by `target_roles`; manager‑only lessons invisible to
bartender/viewer by article/version/media id; no authorization from browser‑sent role/user_id
(actor derived server‑side); private bucket + short‑lived signed access; upload manager‑only,
type/size enforced, generated paths; published version + media immutable; inactive users fail
closed; XSS‑safe rendering; consequential manager actions audited; DB internals never leaked.
