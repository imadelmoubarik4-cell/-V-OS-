# Atlas Training MVP — implementation, tests and acceptance

_Knowledge → Training. Private video SOPs + written procedure + role assignment +
explicit, version-specific completion evidence, built on top of the existing Knowledge
module. Git-only development; no production schema, Storage, data or Edge Function was
changed. See `docs/roadmap/Atlas_Training.md` and
`docs/release/Atlas_Training_T0_Architecture_Audit.md`._

## 1. Product scope delivered

A manager uploads a video, writes a procedure with steps and chapters, targets a role and
publishes; a targeted staff member watches the private video, seeks by chapter, reads the
steps and explicitly completes the lesson; a manager sees who completed the exact immutable
version. Publishing a new version never mutates the previous one's video or completions.
Out-of-scope items (quizzes, AI transcription/chapters, translation, scoring, social
publishing, surveillance telemetry) were deliberately not built.

## 2. Architecture (extends Knowledge, does not replace it)

A training lesson **is** a `knowledge_articles` row with `article_type='training'`. The
immutable draft→published version lifecycle, `target_roles`, `required`, category, search,
acknowledgements and audit are the existing Knowledge machinery, reused. New training
payload hangs off a Knowledge article **version** (whose id is stable across the
draft→published flip, and new for each next edit — so immutability is structural).

- **DB** (`supabase/migrations/20261015090000_s98_training.sql`): private
  `atlas-training-videos` Storage bucket (no `storage.objects` policy); `atlas_private`
  tables `training_media_assets`, `training_lesson_versions`, `training_chapters`,
  `training_steps`, `training_progress` (per user+version, resume + explicit completion),
  `training_events` (append-only audit); service-role-only RLS; `public.atlas_training_*`
  SECURITY DEFINER RPCs granted **only to service_role** (each re-checks the actor), which
  reuse `knowledge_save_draft` / `knowledge_publish` internally.
- **Gateway** (`supabase/functions/atlas-training/`): the only authorization boundary.
  Authenticates every request with `_shared/auth.mjs resolveActor` (verify_jwt=false),
  passes the resolved actor to the RPCs, mints a one-time **signed upload URL** and a
  **300 s signed playback URL** (video bytes never traverse the function), strips storage
  paths from every response, and redacts DB errors by `atlas:` hint.
- **Frontend** (`apps/web/assets/js/training-workspace.js` + `.css`): a self-contained
  `training` shell view under Knowledge → Training. Staff home (Continue / Required /
  Recommended / Library), lesson player (Blob-URL video per CSP, chapter seek, resume,
  explicit completion), manager authoring sheet and a manager completion view. Route
  `#knowledge/training/<id>` (via the `ROUTES.knowledge` resolver in `atlas-shell.js`).

## 3. New tables / structures

`atlas_private.training_media_assets`, `training_lesson_versions`, `training_chapters`,
`training_steps`, `training_progress`, `training_events`. Reused Knowledge structures:
`knowledge_articles` (`article_type='training'`), `knowledge_article_versions`,
`knowledge_categories`, `target_roles`, `required`, search, `knowledge_events`,
`knowledge_task_links` (onboarding bridge — a lesson is an article, so an onboarding task
can already point at it).

## 4. Permission matrix (server-enforced)

| Action | admin | manager | bartender | viewer | inactive |
|---|---|---|---|---|---|
| See published lesson targeting the role | ✅ | ✅ | ✅ (if targeted) | ✅ (if targeted) | ❌ |
| See a draft / manager-only lesson | ✅ | ✅ | ❌ | ❌ | ❌ |
| Upload / author / publish / retire | ✅ | ✅ | ❌ | ❌ | ❌ |
| Play the private video (authorized role) | ✅ | ✅ | ✅ (if targeted, published) | ✅ (if targeted, published) | ❌ |
| Start / save progress / complete (own record) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Manager completion report | ✅ | ✅ | ❌ | ❌ | ❌ |

Authorization is always derived from the server-verified actor; a browser-sent id/role is
never trusted, role forgery is rejected, and inactive profiles fail closed.

## 5. Storage & signed access

Private bucket `atlas-training-videos` (MP4/WebM/MOV, 2 GiB, no `storage.objects` policy).
Immutable object path `lessons/<article>/<asset>.<ext>` (never overwritten for a published
version). Upload: manager-only reserve → one-time signed upload URL → the browser PUTs the
file → the gateway verifies the stored object and finalizes metadata. Playback: the gateway
mints a 300 s signed URL after an authorization check; the browser fetches it into a Blob
and plays the Blob URL (satisfying the site CSP `media-src 'self' blob:` with no CSP change).

## 6. Tests

- **Migration replay** (`scripts/verify_full_migration_replay.sh`, Postgres 17): PASS —
  159 migrations, s98 applies cleanly.
- **DB authorization** (`tests/sql/s98_training.sql`, wired into CI via
  `scripts/verify_s98_training.sh`): PASS — sealed bucket/tables/RPCs, manager
  create→attach→publish, **v2 immutability preserves v1 media + completion**,
  version-specific idempotent completion, playback authz, role-forgery / inactive
  fail-closed.
- **S96 RLS ownership acceptance**: PASS (25/0) — no new browser-executable RPCs, every
  DEFINER function pins `search_path`, no new public tables.
- **Node** (`tests/node/training-s98.test.js` + full suite): PASS — 1533 tests, 0 fail
  (gateway handler with fake services: auth, path-stripping, signed upload/playback,
  finalize, hint redaction, retire gating; plus the S96 verify-jwt allowlist and CSS ratchet).
- **Python contract** (`tests/python/test_training_contract.py`): PASS (8/8) — static
  security invariants.
- **Browser** (`tests/browser/training.browser.test.mjs`): <FILL: result> — full UI flow
  against a faithful mocked backend (manager authoring + upload UI, staff player, chapter
  seek, explicit completion, manager completion view, v2 immutability, role gating).

## 7. Preview / environment

<FILL after PR: Netlify Deploy Preview URL; Supabase preview-branch / real-backend proof
status; any OWNER ACTION REQUIRED for wiring a live browser upload to a non-production
backend, given the app is deliberately pinned to the production Supabase project by
config.js + the netlify.toml CSP + rehearsal-boundary.js.>

## 8. Manual owner acceptance script

Run against a preview/test environment wired to a non-production Supabase project with the
s98 migration applied, the `atlas-training-videos` bucket present and the `atlas-training`
function deployed.

**Manager**
1. Open Knowledge → Training. Confirm **New training** is visible.
2. New training → Basics: title "Opening the Bar", pick a category, target **Bartender**,
   mark **Required**, set ~7 minutes. Save draft.
3. Video: upload a real MP4 from the desktop. Watch Uploading % → Ready.
4. Chapters: add `0:00 Intro`, `0:22 Lights`. Procedure: write a few markdown steps. Steps:
   add two checklist steps. Save draft.
5. Publish.

**Bartender**
6. Sign in as a bartender. Open Knowledge → Training. Confirm the lesson is under
   **Required** and the manager-only lesson (step 15) is **not** visible.
7. Open the lesson. The private video plays. Click a chapter — the video seeks.
8. Leave at ~halfway; reopen — playback resumes near where you left off.
9. Click **I have completed this training**. Confirm the Completed state with the version
   and date.

**Manager**
10. Open the lesson's **View completion** — confirm the bartender shows completed.
11. Edit draft for next version; replace the video; Publish v2.
12. Confirm v1 history remains (the bartender's v1 completion is intact; v1's video is
    unchanged).

**Security**
13. As the bartender, confirm a manager-only training lesson is invisible and its video is
    not reachable (guessing the lesson/version id returns nothing).

## 9. Deferred (post-MVP)

Quizzes, AI transcription / auto-chapters / timestamp answering, translation & dubbing,
resumable TUS upload (MVP uses a single signed-URL PUT), per-person assignment, the
Operations "Watch how" deep-link (architecture allows it; needs a `lesson_id` on checklist
items), transcript search, competency scoring and analytics.

## 10. Guarantees

NO PRODUCTION MIGRATION APPLIED · NO PRODUCTION STORAGE CREATED/CHANGED · NO PRODUCTION
DATA WRITTEN · S96 SECURITY NOT WEAKENED · PR NOT MERGED.
