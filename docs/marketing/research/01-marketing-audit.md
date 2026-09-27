# S94 — Marketing module audit (read-only)

Worktree: `/home/user/-V-OS-/.claude/worktrees/s94` @ `5120a42` (main). All paths relative to that root.
Production project `dnefgcmjcgxlynycxkts` inspected with metadata/count queries only.

---

## 0. TL;DR

- Marketing today is a **manual planning + approval ledger**. No publishing, no media storage, no per-platform delivery, no notifications. "Publish" = a manager clicking "Mark as published" (`mark-published`), which just flips status and stores an (always-empty from UI) `external_publication_ids` object.
- Backend: one Edge Function `supabase/functions/atlas-marketing-workspace/index.ts` (584 lines, **not** the injected-deps handler pattern — uses `Deno.serve` + global `Deno.env`/`fetch`, so no Node unit tests exist for it) → 13 service-role-only `public.atlas_marketing_*` SQL wrappers → `atlas_private.marketing_*` plpgsql (SECURITY INVOKER, `search_path=''`), all created in `supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql` + 4 follow-ups.
- Frontend: `apps/web/assets/js/marketing-workspace.js` (520 lines, IIFE, registers shell view `marketing`, UI is manager/admin-only even though backend lets bartenders write).
- Production: schema **matches repo exactly** (columns, checks, indexes, RLS, triggers, grants, function fixes). **All 7 marketing tables have 0 rows**. The two VÁ seed recommendations were deliberately **omitted** in production by the S33 runtime delta ("Venue-specific marketing recommendations are not baseline data."), so Suggestions are empty in prod. All four social `integration_connections` rows are `not_connected`.
- Notable bugs found (details §9): editing a post in the UI **wipes** `frames`, `creative_brief`, `suggested_format`, `event_*`, `owner_*`, and overwrites `media_requirements` with `{notes}`; editing approved/scheduled content does **not** reset approval; "Plan this → Submit" never submits; create+submit silently skips submit if the new item is outside the loaded month; timezone hard-coded to `Atlantic/Reykjavik` instead of `atlas_private.venue_timezone()`; snapshot date filters use session-TZ `::date` casts.

---

## 1. Files inventory

| Area | File | Notes |
|---|---|---|
| UI JS | `apps/web/assets/js/marketing-workspace.js` | 520 lines; `window.AtlasMarketingWorkspace` |
| UI CSS | `apps/web/assets/css/marketing-workspace.css` | 42 lines, `@layer atlas.modules`, `mk-*` classes |
| Loader | `apps/web/config.js:13` (`MARKETING_WORKSPACE_API` = `https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-marketing-workspace`), `:117-122` (lazy load, `scriptPath: 'assets/js/marketing-workspace.js?v=20260926-s91a'`, css `?v=20260929-s90u`) | cache keys asserted in `tests/node/shell-contract-s88.test.js:264-266` |
| HTML | `apps/web/index.html:41` (css link), `:121` (nav item hidden until role), `:947` (view map `marketing: 'marketing-view'`) | |
| Shell | `apps/web/assets/js/atlas-shell.js:171` (route `#marketing/<section>`), `:674` (nav def, `roles: ROLES_MANAGERS`, group Business) | |
| Edge fn | `supabase/functions/atlas-marketing-workspace/index.ts` | `verify_jwt=false` in `supabase/config.toml:39-40`; auth in handler |
| Migrations | `supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql` (1253 lines, core) · `20260803142450_atlas_marketing_recommendation_occurrences.sql` · `20260803145746_..._occurrence_fix.sql` · `20260803150024_..._dismiss_occurrence_fix.sql` · `20260803150212_atlas_marketing_snapshot_variable_conflict_fix.sql` · `20260803150824_atlas_marketing_foreign_key_indexes.sql` | Production received these via `supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql` (lines ~5907-7560) |
| Other consumers | Reports KPI signal (`20260928090000_s89_canonical_report_truth.sql:608-611, 650`), System snapshot (`20260804134510_atlas_system_snapshot.sql:156-187, 365-366`), System source rows (`20260804134509_atlas_system_checkpoint_i.sql:346, 366`), Settings section `marketing` (`20260804170000_atlas_settings_checkpoint_j_canonical.sql:214-215, 461-462`), Team channel `marketing` (`20260803125226_atlas_team_messages_checkpoint_c.sql:177`) | |
| AI | `supabase/functions/_shared/ai-tools/tools-admin.mjs:246-275` (`marketing.suggestions`), `services.mjs:452-454`, `registry.mjs:71,137`, `specialists.mjs:69-74`, `result.mjs:64,92-93,108`, `context.mjs:131`, `atlas-ai/agents.mjs:24`, UI `apps/web/assets/js/atlas-ai.js:409-410` | read-only |

---

## 2. Data model (repo == production)

All tables in `atlas_private`, RLS enabled, one policy each `"service role manages …" for all to service_role using (true) with check (true)`, `revoke all … from public,anon,authenticated`, `grant all … to service_role` (checkpoint_d.sql:215-252; occurrences.sql:22-27). Production confirms: RLS on, 1 policy each, no anon/authenticated grants.

### 2.1 `marketing_campaigns` (checkpoint_d.sql:1-22)
`id uuid pk`, `name text!`, `description`, `campaign_type text! default 'always_on'` ∈ {promotion, event, seasonal, always_on, brand, other}, `status text! default 'draft'` ∈ {draft, active, paused, completed, cancelled}, `objective`, `target_audience`, `platforms text[]! default '{}'`, `start_date date`, `end_date date` (check end ≥ start), `created_by uuid`, `created_by_label`, `created_by_role`, `updated_by`, `updated_by_label`, `created_at`, `updated_at` (trigger `marketing_campaigns_touch` → `atlas_private.touch_updated_at()`).
Index `marketing_campaigns_status_dates_idx(status,start_date,end_date)`.
**No update/status RPC exists** — campaigns stay `draft` forever; no platform check constraint on `platforms`.

### 2.2 `marketing_content_items` (checkpoint_d.sql:24-64)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| client_request_id | uuid **unique** | idempotency key |
| campaign_id | uuid → campaigns on delete set null | |
| title | text! | 1..180 chars |
| content_type | text! | ∈ post, story, reel, campaign_task, event_promotion, content_idea, google_post |
| status | text! default 'idea' | ∈ idea, draft, pending_approval, changes_requested, approved, scheduled, published, completed, rejected, cancelled |
| priority | text! default 'normal' | ∈ low, normal, high, urgent |
| platforms | text[]! default '{}' | **no DB check**; values enforced only in edge fn |
| scheduled_for | timestamptz | the "post on" instant |
| reminder_at | timestamptz | |
| event_starts_at / event_ends_at | timestamptz | check ends ≥ starts |
| suggested_format | text | |
| caption_draft | text | ≤10000 |
| creative_brief | text | ≤10000 |
| frames | jsonb! default '[]' | check array |
| media_requirements | jsonb! default '{}' | check object |
| owner_id / owner_label | uuid / text | |
| created_by / created_by_label / created_by_role | | |
| published_at / completed_at | timestamptz | |
| external_publication_ids | jsonb! default '{}' | check object — the only per-platform publication slot today |
| metadata | jsonb! default '{}' | check object |
| created_at / updated_at | timestamptz | trigger `marketing_content_items_touch` |

Indexes: `marketing_content_calendar_idx(scheduled_for,status)`, `marketing_content_reminder_idx(reminder_at,status) where reminder_at is not null`, `marketing_content_campaign_idx(campaign_id,status) where campaign_id is not null`, `marketing_content_owner_idx(owner_id,status) where owner_id is not null`, unique `client_request_id`.
No `version`/optimistic-concurrency column (UI handles 409 but server never emits it).

### 2.3 `marketing_content_revisions` (checkpoint_d.sql:66-80)
`id`, `content_id → items on delete cascade`, `revision_number int >0`, unique(content_id,revision_number), `change_type` ∈ {create, edit, status, approval, publication, completion, cancellation}, `previous_payload jsonb`, `new_payload jsonb` (full `to_jsonb(row)` snapshots), `changed_by`, `changed_by_label!`, `changed_by_role!`, `note`, `created_at`. Index `marketing_revisions_content_idx(content_id,revision_number desc)`. Written via `atlas_private.marketing_record_revision(...)` (checkpoint_d.sql:411-442) — computes `max+1` without lock beyond the parent row `for update` held by callers (create path has no lock but is a new row). **Not exposed in the snapshot or UI.**

### 2.4 `marketing_content_approvals` (checkpoint_d.sql:82-92)
`id`, `content_id → items cascade`, `decision` ∈ {submitted, approved, changes_requested, rejected, cancelled}, `actor_id`, `actor_label!`, `actor_role!`, `note`, `created_at`. Index `marketing_approvals_content_idx(content_id,created_at desc)`. `cancelled` decision is never written.

### 2.5 `marketing_recommendations` (checkpoint_d.sql:94-134)
`id`, `recommendation_key text unique`, `title!`, `summary!`, `content_type` (same enum), `platforms text[]`, `recurrence` ∈ {one_off, daily, weekly}, `day_of_week smallint 0..6` (0=Sunday, `extract(dow)`), `active_from/active_to date`, `suggested_time time` (venue wall-clock, naive), `suggested_format`, `caption_draft`, `creative_brief`, `frames jsonb array`, `reason!`, `evidence jsonb array`, `confidence_score numeric 0..1`, `status` ∈ {active, converted, dismissed, expired}, `converted_content_id → items set null`, `converted_at/by/by_label`, `dismissed_at/by/by_label`, `dismiss_reason`, `metadata`, timestamps + touch trigger. Indexes `marketing_recommendations_due_idx(status,recurrence,day_of_week,active_from,active_to)`, `marketing_recommendations_converted_content_idx` (FK fix migration). Seeds (checkpoint_d.sql:321-381): `daily-happy-hour-instagram-story`, `sunday-two-for-one-beer-reel` — **absent in production** (S33 delta omitted them; `supabase/s33/runtime-delta-audit.json`).

### 2.6 `marketing_recommendation_occurrences` (occurrences.sql:1-32)
`id`, `recommendation_id → recs cascade`, `occurrence_date date!`, `state` ∈ {converted, dismissed}, `content_id → items set null`, `actor_id/label/role`, `reason`, timestamps + touch trigger, **unique(recommendation_id, occurrence_date)**. Indexes `..._date_idx(occurrence_date,state,recommendation_id)`, `..._content_idx(content_id) where not null`.

### 2.7 `marketing_workspace_events` (checkpoint_d.sql:136-148)
`id`, `event_type` ∈ {campaign_created, content_created, content_updated, approval_submitted, approval_decided, content_published, content_completed, content_cancelled, recommendation_converted, recommendation_dismissed, connection_state_changed}, `campaign_id`, `content_id`, `recommendation_id` (all FK set null), `actor_id/label/role`, `payload jsonb`, `created_at`. Indexes `marketing_events_created_idx(created_at desc)`, `marketing_events_content_idx`, `marketing_events_campaign_idx`, `marketing_events_recommendation_idx`. `content_cancelled` and `connection_state_changed` are never written. Also unioned into System audit feed (`atlas_system_snapshot.sql:365`).

### 2.8 `integration_connections` additions (checkpoint_d.sql:150-319)
Adds `authorization_state` (not_connected|waiting_authorization|authorized|expired), `publishing_permission_state` / `analytics_permission_state` (not_requested|pending|granted|missing|not_supported), `token_expires_at`, `last_connection_error`; `metadata.automatic_publishing_enabled=false`. S88 (`20260926095000_s88_integrations_oauth.sql`) adds `auth_kind`, `scopes_granted`, `connected_*`, plus `integration_credentials` (encrypted tokens), `integration_oauth_states`, `integration_events`. Display status via `atlas_private.marketing_connection_display_status(...)` (checkpoint_d.sql:383-409).

### 2.9 Production drift check (2026-09-26)
- Columns for all 7 `marketing_*` tables: **identical** to repo.
- Check constraints, indexes, touch triggers (4): identical.
- Functions: all 15 `atlas_private.marketing_*` + 13 `public.atlas_marketing_*` present, `prosecdef=false`, `search_path=""`, no anon/authenticated EXECUTE. Snapshot has `#variable_conflict use_variable`; convert/dismiss occurrence have `v_occurrence_date` fix.
- Row counts: campaigns 0, content_items 0, revisions 0, approvals 0, recommendations **0**, occurrences 0, events 0.
- `integration_connections` for instagram/facebook/tiktok/google-business-profile: all `status=not_connected`, `authorization_state=not_connected`, `publishing_permission_state=not_requested`.
- Production migration history has no `atlas_marketing_*` versions — marketing arrived inside `20260910205055 atlas_s33_runtime_delta`. New S94 migrations will be the first standalone marketing migrations in prod history.

---

## 3. RPC surface (service-role only)

Public wrapper → private impl (all `security invoker`, `search_path=''`, revoke from public/anon/authenticated, grant to service_role):

| public RPC | signature | role check inside | effect |
|---|---|---|---|
| `atlas_marketing_workspace_snapshot` | (uuid,text,date,date) | none (read) | returns JSON (§5) |
| `atlas_marketing_recommendations` | (date) | none | `marketing_recommendations_for_date` |
| `atlas_marketing_create_campaign` | (text,text,text,text,text,text[],date,date,uuid,text,text) | admin/manager | insert draft campaign + `campaign_created` |
| `atlas_marketing_create_content` | 21 args (…jsonb frames, jsonb media_requirements, …, jsonb metadata) | admin/manager/bartender | idempotent on `client_request_id` (returns `{duplicate:true}`); status `idea` if content_idea else `draft`; revision `create`; event `content_created` |
| `atlas_marketing_update_content` | 20 args (no content_type, no metadata) | writers; non-managers must be creator/owner | refuses published/completed/cancelled; **full overwrite** of every field; `changes_requested→draft`; revision `edit`; event `content_updated` |
| `atlas_marketing_submit_approval` | (uuid,text,uuid,text,text) | writers; creator/owner/manager | from idea/draft/changes_requested/**approved** → `pending_approval`; approval row `submitted` |
| `atlas_marketing_decide_approval` | (uuid,text,text,uuid,text,text) | admin/manager | only from `pending_approval`; approved→`scheduled` if `scheduled_for` not null else `approved`; changes_requested/rejected need note |
| `atlas_marketing_mark_published` | (uuid,timestamptz,jsonb,text,uuid,text,text) | admin/manager | from approved/scheduled → `published`, `published_at=coalesce(p,now())`, `external_publication_ids=coalesce(p,'{}')` (replaces, not merges) |
| `atlas_marketing_mark_completed` | (uuid,text,uuid,text,text) | writers; non-task types need manager | any non-final → `completed` |
| `atlas_marketing_convert_recommendation` | legacy (no occurrence) | writers | superseded; still granted |
| `atlas_marketing_convert_recommendation_occurrence` | (uuid,date,uuid,timestamptz,timestamptz,uuid,text,text) | writers | idempotent per client_request_id and per (rec,date); creates `draft` item copying frames, `media_requirements='{}'`, metadata += source_recommendation_id/key/occurrence_date; one_off rec → `converted` |
| `atlas_marketing_dismiss_recommendation` | legacy | managers | superseded |
| `atlas_marketing_dismiss_recommendation_occurrence` | (uuid,date,text,uuid,text,text) | managers | upsert occurrence `dismissed` |

Missing: cancel content, update/advance campaign, reschedule without approval reset, list revisions, per-platform delivery, media.

---

## 4. Edge Function `atlas-marketing-workspace/index.ts`

- Constants: `WRITE_ROLES` (:13) admin/manager/bartender; `MANAGER_ROLES` (:14); **`PLATFORM_KEYS` (:15) = instagram, facebook, tiktok, google-business-profile** (the only server-side platform allowlist; `stringArray(..., 4)` max 4); `CONTENT_TYPES` (:16-24); `PRIORITIES` (:25); `CAMPAIGN_TYPES` (:26); `APPROVAL_DECISIONS` (:27); `MAX_BODY_BYTES` 96 KiB (:28).
- Auth: `requireActiveProfile` (:92-97) → `_shared/auth.mjs resolveActor(request, Deno.env, fetch, …)` validates prod JWT and active profile (roles `ATLAS_ROLES` admin/manager/bartender/viewer, `_shared/auth.mjs:15-17`). `requireWriter` (:99), `requireManager` (:105). SQL re-checks roles again.
- DB access: `branchRpc(name, payload)` (:208-244) POSTs to `${SUPABASE_URL}/rest/v1/rpc/<name>` with service role key; errors mapped 500→500 else 400 (never 409).
- Members: `activeProfiles` (:272-280) reads prod `profiles` with the **user's** token (for owner resolution) — every POST does this call even when not needed.
- Time: local `venueDate()` (:282-291) hard-codes `Atlantic/Reykjavik`; `monthRange` (:293-303) default current venue month, max 93 days.
- Validation helpers: `dateOnly` (:147), `dateTime` (:157 — any `Date`-parsable string → ISO UTC; relies on client sending an offset/Z), `jsonArray(frames, 20)` (:175), `jsonObject(media_requirements)` (:181 — no shape validation), `contentPayload` (:342-368).
- Routing (:370-584): `GET ?action=snapshot&start&end` (:378-395). `POST ?action=` `create-campaign` (manager) :405, `create-content` (writer) :426, `update-content` (writer) :455, `submit-approval` (writer) :483, `decide-approval` (manager) :495, `mark-published` (manager) :508, `mark-completed` (writer) :522, `convert-recommendation` (writer; uses occurrence RPC) :534, `dismiss-recommendation` (manager; occurrence RPC) :549. Each POST returns `{result, workspace (fresh snapshot), staff, members, policy}` (:566-578).
- `staffPayload` (:69-80): `can_create`, `can_approve`, `can_mark_published`, `can_manage_connections`.
- Policy flags returned: `actual_publishing_enabled:false`, `analytics_ingestion_enabled:false`, `oauth_tokens_in_browser:false`, `recommendations_shadow_only`, `manager_approval_required`, `automatic_social_action:false`.
- Pattern gap: not a `createXHandler(deps)` module like `atlas-integrations/handler.mjs:176`; untestable in Node without refactor. Contract only checked textually (`tests/python/test_marketing_workspace_contract.py:153-159`, `tests/node/edge-auth-contract.test.js:145` managerOnly:false).
- Header `x-atlas-marketing-version: 0.1.0` (:60).

---

## 5. Snapshot contract (`atlas_private.marketing_workspace_snapshot`, checkpoint_d.sql:444-696)

Returns `{version:'atlas-marketing-workspace/0.1.0', generated_at, venue_date, range{start_date,end_date}, stats{total_items, ideas, drafts, awaiting_approval, approved, published, completed, overdue_reminders}, campaigns[] (non-cancelled, all time), content_items[], recommendations[] (overwritten by edge fn with `atlas_marketing_recommendations(venueDate())`), reminders[] (non-final with reminder_at ≤ now+14d), connections[] (4 social providers), history[] (last 40 events, global), permissions{can_create,can_approve,can_mark_published,can_manage_connections}, trust{…}}`.

`content_items` filter (:546-551): `scheduled_for::date`, `reminder_at::date` or `event_starts_at::date` between range, **or** unscheduled item in idea/draft/pending_approval/changes_requested/approved. Each item gets `can_edit` (non-final & (manager or creator or owner)), `can_approve` (manager & pending_approval), and embedded `approval_history[]`. Revisions not included. Stats are all-time.

`local_date := (now() at time zone 'Atlantic/Reykjavik')::date` (:457) — hard-coded.

---

## 6. State machine (current)

```
create-content ──► idea (content_idea) | draft (others)
convert-recommendation ──► draft
update-content: any non-final → same status, except changes_requested → draft
submit-approval: idea | draft | changes_requested | approved → pending_approval   [approval: submitted]
decide-approval (manager, from pending_approval only):
   approved  → scheduled (if scheduled_for set) | approved
   changes_requested (note req) → changes_requested
   rejected  (note req) → rejected   (terminal; cannot resubmit)
mark-published (manager): approved | scheduled → published   (terminal for edit)
mark-completed: any except completed|cancelled|rejected → completed (non-task types need manager; includes pending_approval/published)
cancelled: in enum, reachable by NO rpc
```
Gaps: approved/scheduled content is editable (UI + RPC) and keeps approval (no re-approval); changing `scheduled_for` after approval doesn't move approved↔scheduled; `scheduled` does not mean anything is queued — no job reads it; no `publishing`/`failed` states; no cancel; `scheduled_for` in the past is allowed.

UI mapping `STATUS` (marketing-workspace.js:22-26): idea "Idea", draft "Draft", pending_approval "Waiting for approval", changes_requested "Changes requested", approved/scheduled/published/completed positive, rejected/cancelled neutral. `FINAL` (:27) = published, completed, rejected, cancelled.

---

## 7. Time handling

- Browser: every datetime goes through `window.AtlasVenueClock` (`apps/web/assets/js/atlas-venue-clock.js`: `venueDate` :184, `monthRange` :248, `localInputValue` :356, `fromLocalInput` :369). Marketing uses `inputValue`/`fromInput` (marketing-workspace.js:57-58), `venueToday`/`venueKey` (:53-54), `monthRange` (:70-73), calendar `weekday/addDays/monthKey` (:187-221, 470). Tested: `tests/node/atlas-venue-clock.test.js:149-153`, browser `tests/browser/teamc.browser.test.mjs:191-214` (New York browser stores venue time). Ratchet forbids `'12:00'` defaults (`tests/node/venue-hours-ratchet-s88.test.js:18`; `tests/node/marketing-workspace-ui.test.js:51-62` forbids `getTimezoneOffset`, `'Atlantic/Reykjavik'` literals in UI).
- Server SQL: S88 canonical helpers exist — `atlas_private.venue_timezone()` (Settings venue.timezone or default `Atlantic/Reykjavik`) and `atlas_private.venue_date(p_at)` / `venue_business_date(p_at)` in `supabase/migrations/20260926090000_s88_venue_clock.sql:31-80`. **Marketing does not use them**: hard-coded `'Atlantic/Reykjavik'` in snapshot (checkpoint_d.sql:457) and occurrence convert/dismiss (fix migrations :26 / :21); range filter uses `timestamptz::date` (session TZ, UTC on Supabase) — equal to Reykjavík only because Iceland is UTC+0 with no DST; breaks if venue timezone setting changes.
- Edge: `venueDate()` hard-codes `Atlantic/Reykjavik` (index.ts:282-291).
- `suggested_time` is a naive `time`; UI never converts it (plan-suggestion opens editor with date only `${date}T` → incomplete datetime-local value; user must type time).
- `mark-published` sends browser `new Date().toISOString()` (marketing-workspace.js:414) — client clock.

---

## 8. `frames` / `media_requirements` / platforms

- `frames`: jsonb array (≤20 items at edge, no shape check). Seed shape: `[{frame:int, title:text, instruction:text}]` (checkpoint_d.sql:334-338, 354-358). UI **never renders or edits frames** and sends `frames: []` on create (marketing-workspace.js:389).
- `media_requirements`: jsonb object, no shape. UI writes only `{notes: "<text>"}` (marketing-workspace.js:312, 330, 365) with help text "Attach media when you post; Atlas doesn't store post media yet." Convert sets `'{}'`.
- `external_publication_ids`: jsonb object; UI always sends `{}`.
- Platform keys defined in: edge `PLATFORM_KEYS` (index.ts:15); UI `CHANNELS` (marketing-workspace.js:20); snapshot connection filter `provider_key in (...)` (checkpoint_d.sql:616); integration provider registry `supabase/functions/atlas-integrations/providers.mjs:40-218` (`PROVIDER_KEYS` :218; instagram/facebook/tiktok/google-business-profile + others, with `future_scopes` for publishing: `instagram_content_publish`, `pages_manage_posts`, `video.upload/video.publish`, GBP `business.manage`) and seed rows in `20260926095000_s88_integrations_oauth.sql`. **No DB check constraint on `platforms`** in either items or campaigns.

---

## 9. UI walkthrough and defects (`marketing-workspace.js`)

Structure: tabs `TABS` (:18) overview/calendar/posts/campaigns/history; alias `connections→overview` (:19). `render()` (:255-283) gates on `isManager()` (:61) → staff see "Marketing is for managers". Page head actions: Ask Atlas (`AtlasAI.askAbout({type:'marketing'})` :454) + New post draft. Connection caption (:247-253) links `#settings/integrations`. Overview (:170-185): Coming up (next 14 days, by `scheduled_for||reminder_at`), Waiting for approval, Suggestions (`available_for_today !== false`, "Plan this" if `is_due_today`). Calendar (:187-221): Monday-first 6-week grid, max 3 items/day + "N more", list fallback on ≤767px (css:38-41); day number button opens editor prefilled `${date}T`. Posts (:223-233) filters active/drafts/approval/approved. Campaigns (:235-239) list + create dialog (`openCampaign` :422-446). History (:241-245): final items + last 40 events. Editor sheet `openEditor` (:303-420): title, type (locked after create), campaign, channel checkboxes, text, media notes, "Post on (venue time)", "Remind me", live preview (single generic card), note + Reject/Request changes/Approve for managers on pending, "Mark as published" for approved/scheduled, else Save draft / Submit. Command palette action `marketing.post.new` (:495). Deep link `#marketing?recommendation=<id>` (:277-282, 476-478).

Defects/risks:
1. **Data loss on edit** — `collect()` (:359-368) omits frames, creative_brief, suggested_format, event_starts_at/ends_at, owner_id; `update-content` rebuilds everything via `contentPayload` (index.ts:342-368) and the RPC overwrites all columns (checkpoint_d.sql:855-873). Any save from the UI nulls those fields and sets `frames=[]`, `media_requirements={notes}`. Suggestion-converted items lose their frames/brief on first save.
2. **Plan suggestion + Submit** does not submit: in the suggestion branch `contentId` stays null (:382-384, 392).
3. **Create + Submit** finds the new id by diffing the refreshed snapshot (:388-390); items scheduled outside the loaded month aren't in the snapshot → submit silently skipped, but toast says "Draft saved." only. The RPC result (`payload.result.content.id`) is ignored by `mutate` (:127-145).
4. Post-approval edits keep approval (UI shows Mark-as-published footer to managers, but a bartender owner via API or a manager with no publish flag could edit). Fields remain enabled for managers on approved items but no save button — confusing.
5. Backend-supported actions with no UI: mark-completed, dismiss-recommendation, campaign status changes; campaign sheet only name/type/dates/description.
6. UI 409 handling (:103, 140) is dead — server never returns 409; no optimistic concurrency.
7. UI manager-only while backend `can_create` includes bartender; shell nav `roles: ROLES_MANAGERS`; AI `marketing.suggestions` & `app.open marketing` are `roles: ALL` (tools-admin.mjs:249, 321).
8. `suggested_time` ignored when planning a suggestion (datetime left incomplete).
9. Settings marketing section (`approval_required`, `default_story_frames`, `brand_voice`, `ai_caption_drafts_enabled`) is not read by the Marketing module at all.
10. Reports KPI filter mentions status `'archived'` which is not in the enum (s89 migration :609) — harmless.

---

## 10. Home / notifications / Atlas AI

- **Home**: no marketing card/contribution (grep of Home/briefing JS and `atlas-sprint4-briefing` finds none). Marketing only appears as nav item, palette action `marketing.post.new` (contexts `['marketing','home']`), Knowledge live-route link.
- **Notifications**: `supabase/functions/atlas-notifications/index.ts` only dispatches `atlas_private.push_notification_queue`, whose `event_type` check is `('team_message','shift_update')` and `route in ('team','shifts')` (`20260911124039_s34_notification_and_conversation_stars.sql:35-47`); enqueued only from atlas-team-messages (:590) and atlas-shifts (:313). `settings_notification_policies` seeds have no marketing event key (checkpoint_j:262-276). `reminder_at` is stored but **nothing fires reminders**; approval submissions notify nobody.
- **Reports**: "N marketing items are due in this period" signal for managers (s89:608-611, 650).
- **System**: source `marketing-planning` (row count/last updated), `marketing-reminders` (static "healthy"), audit feed includes marketing events.
- **Atlas AI**: single read tool `marketing.suggestions` (tools-admin.mjs:246-275) → `services.marketingRecommendations` → `atlas_marketing_recommendations(p_local_date)` via serviceRpc for all roles (services.mjs:452-454); records `marketing_recommendation` → `#marketing?recommendation=<id>` (result.mjs:92). Specialist `marketing` (specialists.mjs:69-74) says ideas are seeded templates. **No AI tools read/write content items, drafts or captions**; no marketing action in `actions.mjs` (only team channel `marketing` for message drafts). In production it will always return "No marketing ideas" (0 recommendations).

---

## 11. Tests covering marketing

- `tests/node/marketing-workspace-ui.test.js` (87 lines): static regex checks on config/UI/CSS/migrations (tabs, copy, no service key, venue-clock usage, no provider URLs, CSS layer).
- `tests/python/test_marketing_workspace_contract.py` (196 lines): static SQL/edge text checks (RLS, revokes/grants, enums, seeds, occurrence fixes, service-role-only RPCs, no `security definer`, edge auth strings).
- `tests/browser/teamc.browser.test.mjs:189-240` + fixture `tests/browser/teamc-fixtures.mjs:182-206`: overview, create-content from NY timezone stores venue time, approve via sheet, staff lock screen, phone calendar list. Also `shell.browser.test.mjs:61,74`, `shell-ui.browser.test.mjs:34,100`, `ux-acceptance.browser.test.mjs` routes, `ai-record-links.browser.test.mjs:60-67`.
- Contract tests: `tests/node/shell-contract-s88.test.js:219, 264-266` (cache key `20260926-s91a`), `tests/node/edge-auth-contract.test.js:145`, `tests/node/ai-route-parity-s89.test.js:57,110`, `tests/node/ai-tools-operations-people.test.js:166-169`, `ai-tools-registry.test.js:24`, `ai-tools-gateway.test.js:55`, `global-search-v1.test.js:35`.
- **No SQL preview script** for marketing (compare `scripts/verify_s88_*_preview.sql`), no Node behavioural test of the edge function, no test of the state machine or of update-content field preservation.
- Any change to marketing-workspace.js/.css requires bumping cache keys in `apps/web/config.js:118-119`, `apps/web/index.html:41` and the shell-contract test.

---

## 12. Extension points for S94 (publishing platform)

1. **Media attachments**: follow `atlas-profile-photos` / `atlas-ai-media` pattern — private bucket, no `storage.objects` policies, edge function uploads with service role and signs short-lived URLs (`20260926104000_s88_ai_media_bucket.sql`, `atlas-team-profile-photos/index.ts:250`, `atlas-ai/http.mjs:248`). Add `atlas_private.marketing_media` (content_id FK cascade, storage_path check regex, mime, bytes, width/height/duration, sort_order, per-platform crop/variant, uploaded_by) rather than overloading `media_requirements` (keep that for the *brief*). Snapshot should return signed URLs or ids; editor preview then shows real media. Frames could reference media ids (`frames[i].media_id`).
2. **Per-platform deliveries**: new `atlas_private.marketing_deliveries` (content_id, platform_key check in the 4 keys, status e.g. pending/queued/publishing/published/failed/cancelled/manual, scheduled_for, caption_override, external_id, external_url, attempt_count, last_error, published_at, idempotency key unique(content_id,platform_key)). Populate `external_publication_ids` from it or deprecate it. Add a DB check on `platforms` values.
3. **Publish now**: new action in edge fn → RPC that requires `approved|scheduled`, creates/claims deliveries, calls provider via `atlas-integrations` credential store (tokens only server-side; `providers.mjs` has `future_scopes` for publish that are not yet requested). Needs `publishing_permission_state='granted'` gate; otherwise fall back to today's manual `mark-published` per platform.
4. **Scheduled publishing**: a dispatcher (cron → edge function) claiming due deliveries (`scheduled_for <= now()`) with `for update skip locked`, mirroring `atlas_push_notification_claim/complete` in atlas-notifications. Also a natural place to fire `reminder_at` notifications (extend `push_notification_queue` event_type/route checks with `marketing_*` / `marketing`).
5. **Calendar**: server range filter should become `atlas_private.venue_date(scheduled_for) between …` (and use `venue_timezone()` everywhere); consider delivery-level entries per platform; drag-to-reschedule needs a reschedule RPC that decides whether approval is kept.
6. **History**: revisions table already stores full before/after snapshots but is unexposed; add a `history` action returning revisions + approvals + deliveries per item. Event enum must be extended for new event types (check constraint on `marketing_workspace_events.event_type`).
7. **State machine**: add cancel RPC (status & `content_cancelled` event already exist), re-approval on material edits after approval, a `version`/`updated_at` precondition to produce real 409s, and fix update-content to be a partial patch (or have UI send full field set).
8. **Refactor edge fn to handler pattern** (`handler.mjs` exporting `createMarketingHandler({env, fetch, …})` + thin `index.ts`) so Node tests can exercise actions like `atlas-integrations`.
9. **Timezone**: replace hard-coded `'Atlantic/Reykjavik'` in SQL with `atlas_private.venue_timezone()`/`venue_date()`; edge fn should get venue date from DB or the shared clock rather than a literal.
10. **Seeds**: production has no recommendations; decide whether S94 seeds VÁ recommendations in a prod migration or leaves Suggestions empty.

## 13. Risks

- Any UI save today destroys frames/brief/format/event/owner data (low impact now: prod has 0 rows; must fix before real use or before media/deliveries hang off items).
- Approved content can be changed without re-approval → publishing pipeline could post unapproved text.
- Hard-coded timezone and `::date` in UTC session — safe for Iceland only.
- `mark-published` / "scheduled" semantics will change meaning when real publishing lands; existing copy ("Nothing was posted by Atlas") and policy flags (`actual_publishing_enabled:false` in edge fn + snapshot `trust`, settings guard forcing `automatic_publishing_enabled=false` at checkpoint_j:461-462) must be updated consistently; Python/Node tests assert several of these strings.
- Settings forcibly writes `automatic_publishing_enabled=false` on every marketing section save — a real publishing toggle needs that guard changed.
- Role mismatch (UI managers only vs backend bartender writes vs AI ALL) should be resolved deliberately.
- Edge function performs an extra prod `profiles` fetch on every POST and full snapshot refresh; scalable enough for one venue but adds latency.
- Tokens: provider publishing scopes are not requested yet (`future_scopes`), so "publish now" requires re-consent through atlas-integrations and Meta/TikTok app review — outside code control.
