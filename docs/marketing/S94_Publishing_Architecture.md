# S94 Atlas Marketing Publishing Platform: architecture and build contract

This document is the binding contract for S94A (Media Library), S94B (Social Publishing
Connections) and S94C (Scheduler and Delivery Queue). It reconciles nine investigation
reports (current Marketing, S88 integrations, media storage, Meta, TikTok, Google Business
Profile, scheduler/idempotency, UX, tests). Every S94 implementation must match the names,
signatures and payload shapes below. Where a report and this document disagree, this document
wins; where this document is silent, follow the report named in the section.

Research reports (kept with the release): `docs/marketing/research/0[1-9]-*.md`.

Provider facts were researched from primary documentation, but the sandbox could not open
developers.facebook.com, developers.tiktok.com or developers.google.com directly. Facts are
tagged in the research files as verified (search extracts or live discovery documents of the
official pages) or UNVERIFIED. **Every UNVERIFIED limit must be rechecked on the live pages
before the first real publication** (release checklist, §12).

---

## 0. Principles (non-negotiable)

1. **Approval first.** Nothing is published unless a manager or admin approved that exact content
   (caption, media, targets and time; §5.3 fingerprint). An edit after approval cancels the
   unstarted deliveries and needs approval again. Atlas AI can draft, never approve or publish.
2. **Automatic publishing is off until an admin turns it on** (Settings › Marketing,
   `automatic_publishing_enabled`, default false). While off, approved posts wait as "Ready, not
   sent" and Publish now is refused with a clear message.
3. **One delivery path.** Publish now makes the deliveries due now and wakes the worker; it is not
   a second code path.
4. **One delivery per platform target.** Content-level status is derived from deliveries. A
   published delivery is final. Retrying one platform never touches another.
5. **Never double-post.** Provider ids are saved before the next call; a "submitting" marker is
   committed before any non-idempotent call; an uncertain outcome is verified with the provider,
   never blindly retried.
6. **Secrets stay server-side.** Tokens are encrypted (S88 AES-256-GCM); the browser never sees
   tokens, signed provider URLs or the worker secret. Media stays in a private bucket; providers
   get short-lived signed URLs minted by the worker at publish time only.
7. **Server-side authorization.** Every new action checks the role on the server (Edge) and again
   in SQL. S94 actions are admin/manager only.
8. **No real public post from tests or agents.** Provider HTTP is mocked in every automated test.
   Live publication requires the owner's explicit approval for that specific post (§12).

## 1. Components and ownership

| Component | Path | Track |
|---|---|---|
| Media migration | `supabase/migrations/20261004090000_s94a_marketing_media.sql` | S94A |
| Media gateway | `supabase/functions/atlas-marketing-media/{index.ts,handler.mjs}` | S94A |
| Media UI | `apps/web/assets/js/marketing-media.js` (`window.AtlasMarketingMedia`) | S94A |
| Connections migration | `supabase/migrations/20261004091000_s94b_publishing_connections.sql` | S94B |
| Integrations gateway | `supabase/functions/atlas-integrations/*` (extended) | S94B |
| Credential module | `supabase/functions/_shared/integrations/credentials.mjs` | S94B |
| Settings UI | `apps/web/assets/js/settings-workspace.js` (Integrations section) | S94B |
| Publishing migration | `supabase/migrations/20261004092000_s94c_marketing_publishing.sql` | S94C |
| Worker | `supabase/functions/atlas-marketing-publisher/{index.ts,handler.mjs}` | S94C |
| Provider adapters | `supabase/functions/_shared/publishing/{meta.mjs,instagram.mjs,facebook.mjs,tiktok.mjs,gbp.mjs,classify.mjs,media-urls.mjs}` | S94C |
| Platform rules | `supabase/functions/_shared/publishing/rules.mjs` (+ generated browser copy `apps/web/assets/js/marketing-platform-rules.js`, `window.AtlasPlatformRules`, parity test) | S94C |
| Marketing gateway | `supabase/functions/atlas-marketing-workspace/{index.ts,handler.mjs}` (refactored to the handler pattern) | S94C/UI |
| Marketing UI | `apps/web/assets/js/marketing-workspace.js`, `apps/web/assets/css/marketing-workspace.css` | S94C/UI |

Migration order: s94a → s94b → s94c. The s94c migration depends on tables from s94a and s94b.
No new stylesheet file (ratchet: 19). Media and composer CSS live in `marketing-workspace.css`
(module layer), each track in its own clearly headed section.

## 2. Shared vocabulary

- Platform keys: `instagram`, `facebook`, `tiktok`, `google-business-profile` (existing).
- Target kinds (delivery placement): `ig_feed` (single image), `ig_carousel`, `ig_reel`,
  `fb_page_post` (text/link), `fb_page_photo` (one or more photos), `fb_page_video`, `fb_reel`,
  `tiktok_video` (Direct Post), `tiktok_inbox_video` (upload to the creator's TikTok inbox/drafts),
  `gbp_local_post`. (`ig_story`, `tiktok_photo` reserved, not offered in v1.)
- Media kinds: `image`, `video`. Orientation is derived (`portrait`, `landscape`, `square`) from
  width/height; "Reel" and "TikTok video" are target kinds, not media kinds.
- Delivery statuses: `queued, publishing, processing, verifying, retrying, published, failed,
  needs_attention, cancelled` (report 07 §2.3 transition table is binding).
- Content statuses (existing enum kept): `idea, draft, pending_approval, changes_requested,
  approved, scheduled, published, completed, rejected, cancelled`. The snapshot adds a derived
  `publication_state`: `none | ready_not_sent | queued | publishing | partial | published |
  attention`.

## 3. S94A Media Library

Report 03 is binding for bucket, paths, upload, verification, variants, deletion and schema
(§4 of report 03), with these decisions:

- Bucket `atlas-marketing-media`: private, no `storage.objects` policies, `file_size_limit`
  1 GiB, `allowed_mime_types` jpeg, png, webp, heic, heif, mp4, quicktime. Paths
  `venues/main/{yyyy}/{mm}/{asset_uuid}/original.{ext}`, variants `.../v/{variant_uuid}.{ext}`.
- Upload: the gateway reserves the asset row and returns a one-time signed upload URL/token for
  that exact path (Storage `object/upload/sign`). The browser uploads directly to Storage
  (single PUT up to 6 MiB; TUS resumable above, token in `x-signature`). `complete` verifies
  size and magic bytes server-side (ranged reads) before `ready`.
- Metadata: server-parsed where possible (JPEG/PNG/WebP dimensions, MP4/MOV `mvhd`/`tkhd`
  duration and dimensions); browser values are bounded hints (`metadata_source`).
- Variants: browser-generated JPEG thumbnail (400 px), video poster (chosen frame), crops
  (1:1, 4:5, 9:16, 16:9, 1.91:1) and a JPEG "publish" copy for PNG/WebP/HEIC photos (Instagram
  and Google accept JPEG; Google also PNG). Masters are never modified.
- Collections: ordered items; reorder by explicit array; order preserved into content attachment
  and into the approval snapshot.
- Content attachment `marketing_content_media` (report 03 §4.6): one row per attached item,
  `position`, `role` (`primary|cover|item|thumbnail`), optional `platform` override, optional
  `variant_id` (e.g. a 4:5 crop for Instagram). Attaching a collection copies its items in
  order and records `collection_id` for provenance (add column `collection_id uuid null`).
- Deletion: archive or soft delete (30-day purge); refused while attached to content that is
  approved/scheduled/published or has been published (`marketing_media_publication_uses`).
- Tags: free per-venue tags (no hard-coded venue tags).

Gateway `atlas-marketing-media` actions (admin/manager; JSON; handler pattern):
`GET list` (filters: kind, tag, q, used, collection, archived, cursor), `GET asset&id`
(with 5-minute signed thumbnail/preview URLs), `POST reserve` → `{asset, upload:{url, token,
method:'put'|'tus', expires_at}}`, `POST complete`, `POST abandon`, `POST reserve-variant`,
`POST complete-variant`, `POST update` (title, alt_text, notes, tags, focal point in
`metadata.focal_point {x,y}`, trim in `metadata.trim {start_ms,end_ms}`, cover `variant`),
`POST archive|restore|delete`, collections `POST collection-upsert|collection-reorder|
collection-archive`, `GET collections`. Signed preview URLs for the browser are 5 minutes and
never stored. Worker-only RPC: `public.atlas_marketing_media_resolve(p_asset_ids uuid[],
p_variant_ids uuid[])` returning storage paths/metadata (service role; no URLs).

Browser module `window.AtlasMarketingMedia`:
`mount(host, {mode:'library'})` (the Media tab), `pick({multiple, kinds, allowCollections}) →
Promise<[{asset_id, variant_id?, collection_id?, kind, thumb_url, width, height, duration_ms,
mime_type, byte_size}]|null>` (library/collection picker sheet with Upload new),
`upload(files) → Promise<assets>` (reusing the queue), `thumbUrl(asset)`.

## 4. S94B Social Publishing Connections

Report 02 §13 and provider reports 04–06 are binding, with these decisions:

- **Scope sets.** Each provider gets `scopes` (connect/verify, unchanged minimal set) and
  `publish_scopes` (requested only when an admin/manager presses "Allow publishing"; `start`
  with `purpose: 'publishing'` requests connect ∪ publish scopes):
  - facebook: `pages_show_list, pages_read_engagement, pages_manage_posts, business_management`
  - instagram: `instagram_basic, instagram_content_publish, pages_show_list,
    pages_read_engagement, business_management`
  - tiktok: `video.upload, video.publish` (connect keeps `user.info.basic`)
  - google-business-profile: none extra (`business.manage` already covers local posts)
  Verify still requires only `scopes`. `publishing_permission_state` is derived on every
  verify: `granted` when all publish scopes are granted (GBP: when a location is selected and
  API access is confirmed), `missing` when connected without them, `not_requested` before.
  This also fixes the Marketing "waiting for authorization" bug (report 02 §9).
- **Review state.** New column `integration_connections.publishing_review_state` in
  (`not_required, unknown, required, pending, approved, rejected`), default `unknown`, set by an
  admin in Settings (platform review is not readable by API). TikTok Direct Post requires
  `approved`; otherwise only `tiktok_inbox_video` (and SELF_ONLY Direct Post for testing) is
  offered. GBP: `approved` means Google granted Business Profile API access.
- **Resources.** New table `atlas_private.integration_resources` (`provider_key`, `resource_kind`
  in `facebook_page, instagram_account, gbp_account, gbp_location, tiktok_account`,
  `resource_id`, `parent_resource_id`, `label`, `metadata` (non-secret: category, username,
  address summary, tasks), `selected boolean`, `refreshed_at`), unique (provider_key,
  resource_kind, resource_id), one selected per (provider_key, resource_kind) via partial unique
  index. Actions `list-resources` (live fetch from the provider, server-side, stores the rows,
  returns ids and labels only) and `select-resource`. Instagram accounts are listed through the
  Pages the user manages (`instagram_business_account`); no `[0]` defaults anywhere.
- **Page tokens.** Facebook/Instagram publishing uses the selected Page's access token, stored
  encrypted in new table `atlas_private.integration_resource_credentials` (provider_key,
  resource_kind, resource_id, ciphertext, nonce, key_version, created_at, rotated_at), AAD
  `atlas-integrations|<provider>|resource|<resource_id>`.
- **Meta disconnect coupling.** Disconnecting one of facebook/instagram revokes only that
  provider's specific permissions (`DELETE /me/permissions/{permission}`) when the other Meta
  provider is still connected.
- **Worker token access.** `_shared/integrations/credentials.mjs` exports
  `openPublishingCredential({ rpc, env, fetchImpl, now }, { deliveryId, claimToken })` →
  `{ provider_key, access_token, resource: { kind, id, label }, expires_at }` (server memory only).
  It calls the service-role RPC `public.atlas_integration_read_credential_for_delivery(p_delivery_id
  uuid, p_claim_token uuid) returns jsonb` which returns ciphertexts only if the delivery is
  currently claimed with that token, the content is approved and the connection has publishing
  permission; it records event `credential_used`. Refresh (Google, TikTok) happens inside the
  module under a row lock (`atlas_integration_refresh_lock(p_provider)` / `for update`),
  re-stores the credential and records `refreshed`/`refresh_failed`.
- **Readiness RPC** (used by the Marketing gateway, composer and claim gate):
  `public.atlas_integration_publish_targets() returns jsonb` → array of
  `{provider_key, connection_state, publishing_permission_state, publishing_review_state,
  resource: {kind, id, label}|null, ready boolean, reason text|null, target_kinds text[]}`.
  `reason` ∈ `not_connected, needs_reauthorization, publishing_permission_missing,
  review_required, review_pending, no_resource_selected, not_configured`.
- Event types added: `publish_scope_requested, resource_listed, resource_selected,
  credential_used, review_state_set`. Credential kinds unchanged (resource tokens live in their
  own table).
- Settings › Integrations UI (report 08 §13): per provider pill + status line + owner action for
  every state (Not set up yet, Ready to connect, Connected, Publishing allowed, Publishing
  permission missing, Needs reconnecting, Verification failed, App review required, Platform
  review pending, No Page/account/location chosen), "Allow publishing" button, resource picker
  sheet, admin review-state control. Never shows tokens or secrets.

## 5. S94C Publishing

Report 07 is binding for the delivery table, attempt ledger, provider-account rate state,
transition trigger, claim/lease/fencing, retry classification and backoff, per-provider
idempotency, approval gate and notifications, with these decisions:

### 5.1 Content model changes (same migration, s94c)
- `marketing_content_items` gains `version integer not null default 1`, `platform_options jsonb
  not null default '{}'` (per platform: `{caption, target_kind, tiktok:{privacy_level,
  disable_comment, disable_duet, disable_stitch, brand_content_toggle, brand_organic_toggle,
  consent_confirmed_at, consent_by}, gbp:{topic_type, call_to_action:{action_type, url},
  event:{title, start, end}, offer:{coupon_code, redeem_online_url, terms}}}`),
  `approved_fingerprint bytea`, `approval_id uuid`.
- `update-content` becomes a partial patch with `p_expected_version` (409 `stale_request` on
  mismatch); it never clears fields that were not sent (fixes data loss).
- Material edits (caption, overrides, media, targets, scheduled_for, platform options) to
  approved/scheduled content: cancel unstarted deliveries (`superseded_by_edit`), clear the
  approval, status → `draft` (the UI confirms first). Title/notes edits don't reset approval.
- New RPCs: `cancel` (future content; cancels unstarted deliveries; in-flight ones get
  `cancel_requested_at`), `reschedule` (moves `scheduled_for` of unpublished content; counts as
  a material edit → re-approval), `duplicate` (new draft copying caption, options and media
  attachments), fixes for "plan this + submit" and create+submit (return the created id).
- Venue time: replace hard-coded `'Atlantic/Reykjavik'` with `atlas_private.venue_timezone()` /
  `venue_date()` in marketing SQL, and the gateway reads the venue date from the snapshot.

### 5.2 Deliveries
- Created by `atlas_private.marketing_deliveries_create_for_approval(p_content_id, p_approval_id)`
  inside `decide_approval` (approved): one per selected platform with its `target_kind`
  (derived by rules), `external_account_id` = selected resource id (or `pending` when none yet;
  such rows go `needs_attention/no_resource` at claim), `due_at = scheduled_for` (or now for
  "approve and publish now"), `payload_snapshot` frozen: effective caption (override or common),
  ordered media `[{asset_id, variant_id, storage_path, mime_type, width, height, duration_ms,
  byte_size, sha256, position, role}]`, platform options, content title. The worker publishes the
  snapshot only.
- `latest_acceptable_at`: `due_at + 6 hours` by default; for event promotions `least(due_at +
  6h, event_starts_at)`.
- Claim gate (SQL): content approved/scheduled with matching fingerprint, not cancelled,
  `automatic_publishing_enabled` true, provider ready (publish permission, resource, review
  state allows the target kind), not stale, rate budget available.
- Manager actions via the Marketing gateway: `publish-now` (content), `retry-delivery` (one
  delivery; refused after `submitting` unless the manager attests it was not posted),
  `mark-delivery-posted` (permalink), `cancel-delivery`.
- `marketing_publication_history(p_content_id)` returns deliveries with attempts (steps without
  secrets), approvals and revisions for History.

### 5.3 Fingerprint
`sha256` of canonical JSON: effective caption per platform, ordered media (asset id, variant id,
sha256), targets (platform + target kind + resource id), `scheduled_for` (or null), platform
options. Stored at approval; recomputed at claim and at `begin_submit`; mismatch → the delivery is
cancelled `superseded_by_edit`.

### 5.4 Scheduler and worker
- `pg_cron` (every minute) → `atlas_private.marketing_publisher_tick()` → if anything is due,
  `net.http_post` to `/functions/v1/atlas-marketing-publisher` with header
  `x-atlas-publisher-secret` read from Vault (`atlas_marketing_publisher_secret`). The migration
  creates the tick function guarded (`if pg_cron/pg_net missing: skip`); scheduling the cron job
  and creating the Vault secret are owner-run rollout steps (DEPLOYMENT.md). `pg_net` goes in
  schema `extensions`.
- Worker `atlas-marketing-publisher` (`verify_jwt=false`): constant-time secret check
  (`ATLAS_MARKETING_PUBLISHER_SECRET`), claims up to N deliveries, runs the provider adapter,
  records steps/outcomes via the fenced RPCs, heartbeats long uploads, never logs URLs or tokens.
  The Marketing gateway's publish-now also wakes it (same secret, server-side).
- Adapters implement `publish(ctx, delivery) → outcome` where `ctx = { http, credential,
  mediaUrls, recordStep, beginSubmit, heartbeat, now }` and outcome is one of
  `{status:'published', post_id, permalink, published_at}`, `{status:'processing', ids,
  poll_after_s}`, `{status:'retrying'|'verifying'|'failed'|'needs_attention', error:{class, code,
  message}}` (report 07 §4, §5).
- Media to providers: Instagram/Facebook/Google by short-lived signed Storage URL (lifetime per
  provider: IG 60 min for video, 15 min images; FB 30 min; GBP 15 min) minted just before the
  call; TikTok video by FILE_UPLOAD from the worker (chunks streamed from Storage within Edge
  limits, one or more claims, heartbeats). URLs appear in no log, event or row
  (`marketing_media_publication_uses` stores only `url_expires_at`).
- Supported v1 matrix (rules.mjs enforces; limits per research, UNVERIFIED items flagged in code
  comments):
  - Instagram: single JPEG (4:5–1.91:1) → `ig_feed`; 2–10 images/videos → `ig_carousel`;
    one video (MP4/MOV, 3 s–15 min, ≤300 MB) → `ig_reel`; caption ≤2200 chars, ≤30 hashtags.
  - Facebook Page: text only → `fb_page_post`; 1+ photos → `fb_page_photo` (multi-photo via
    unpublished photos + `attached_media`); one video → `fb_page_video`; vertical video →
    `fb_reel` when chosen.
  - TikTok: one video only (`tiktok_inbox_video` default; `tiktok_video` Direct Post when review
    approved), creator-info checks (privacy options, max duration), mandatory consent; photo
    posts unsupported in v1 (need a verified pull domain).
  - Google Business Profile: STANDARD/EVENT/OFFER/ALERT with optional call to action; 0–1 photo
    (JPEG/PNG, 10 KB–5 MB, ≥250×250); video unsupported via API in v1; summary ≤1500 chars
    (UNVERIFIED); post `state` polled until LIVE/REJECTED.
- Rate state: `marketing_provider_accounts` (cooldowns on 429, IG rolling 24 h publish cap with
  an Atlas safety cap of 25/day, TikTok per-minute caps, GBP 10 edits/min/location → serialized).

### 5.5 Notifications
Needs-attention and permanent failures write a Marketing event and enqueue one push per delivery
(extend `push_notification_queue` event_type with `marketing_attention` and route `marketing`)
to active managers/admins and the content owner. The Marketing module contributes the same items
to the shell notification feed (bell). No notification for successful posts. Integrations that
need reconnecting and unresolved month problems ("N posts next 30 days can't be published")
appear in Marketing Overview and the bell.

## 6. Marketing gateway contract (`atlas-marketing-workspace`)
Refactored to `handler.mjs` (`createMarketingHandler({env, fetchImpl, now, resolveActor?})`) +
thin `index.ts`; existing actions keep their names and payloads. Added actions (manager/admin
unless noted): `update-content` (partial, `version`), `cancel-content`, `reschedule-content`,
`duplicate-content`, `set-content-media` (ordered items), `publish-now`, `retry-delivery`,
`cancel-delivery`, `mark-delivery-posted`, `GET history&content_id`, `GET publish-targets`
(readiness from §4), `GET tiktok-creator-info` (live creator info via the credential module:
nickname, privacy options, disabled interactions, max duration; nothing cached). The snapshot
adds per item: `version`, `platform_options`, `media` (ordered, with 5-minute signed thumb
URLs from the media gateway helper), `deliveries` (status, target_kind, published_at,
permalink, attention reason, next_attempt_at), `publication_state`; and top-level
`publish_targets`, `automatic_publishing_enabled`, `attention` counts.

## 7. UI (report 08 is binding)
Tabs Overview · Calendar · Posts · Media · Campaigns · History. Composer as a routed page
(`#marketing/post/<id>` and `#marketing/new`), two columns on desktop, Edit | Preview on phone;
channel chips; Add media (Upload new / From library / From a collection) via
`AtlasMarketingMedia.pick`; reorderable media strip (move up/down + drag on desktop); common
caption with per-platform overrides; TikTok and Google sections only when selected; previews
per platform; blocking vs warning checks from `AtlasPlatformRules.validate`; schedule in venue
time; approval footer per state; Publish now. Calendar month grid with thumbnails, time,
per-platform status dots with letters; phone agenda list. History: one row per platform with
status, times, link, attempts and Retry for the failed platform only.

## 8. Roles
Admin and manager: everything in S94 (admin only: Settings automatic publishing switch,
publishing review state). Bartender/viewer: no Media, no publishing, no connections (existing
bartender draft creation in the backend is left as is; the UI stays manager-only). Server-side
checks in every Edge action and every RPC.

## 9. Security checklist (reviewed before release)
Private bucket, no storage policies; signed upload tokens per exact path, server verification of
size and magic bytes, extension/MIME allowlist, 1 GiB cap, no SVG/HTML; no public service-role
RPCs; tokens encrypted, never in responses/events/attempt steps (DB check constraints); URLs
never logged; worker secret constant-time and Vault-held; SSRF: worker fetches only our Storage
and allowlisted provider hosts, provider-returned upload URLs must match the allowlist;
sanitized provider errors (240 chars, token redaction); OAuth state as S88; least-privilege scopes;
RLS on every table.

## 10. Tests (report 09 is binding)
SQL previews `scripts/verify_s94a_media_preview.sql`, `verify_s94b_connections_preview.sql`,
`verify_s94c_publishing_preview.sql` (added to the preview runner); concurrency proof
`scripts/verify_s94c_claim_concurrency.sh` (dblink/pgbench on a throw-away copy of the replay
DB); Node: media gateway, integrations extensions, credential module, rules (+ browser parity),
worker with provider fakes (all scenarios of report 07 §8.3 and report 09 §6), marketing gateway;
browser: Media tab, upload queue, collections reorder, composer, previews and validation,
approval, publish now, calendar month, History and Retry, Settings integrations states and
picker, at 1440 and 390, admin/manager/bartender.

## 11. Rollout (owner steps are marked OWNER)
1. Apply s94a → s94b → s94c (controlled workflow, not `db push`).
2. Deploy `atlas-marketing-media`, `atlas-integrations`, `atlas-marketing-publisher`,
   `atlas-marketing-workspace`.
3. OWNER: raise the project Storage global file-size limit to ≥1 GiB.
4. OWNER: create the Vault secret and the Edge secret `ATLAS_MARKETING_PUBLISHER_SECRET`; enable
   `pg_cron` and `pg_net` (schema `extensions`); schedule the tick (SQL in DEPLOYMENT.md).
5. Web app deploy.
6. OWNER: Meta app (Facebook Login for Business, permissions above, Business Verification, App
   Review/Advanced Access), TikTok app (Content Posting API, scopes, audit for Direct Post),
   Google Business Profile API access application; register redirect URIs.
7. OWNER: connect each provider, Allow publishing, choose Page/account/location, set review state.
8. Smoke tests without public posts (§12); then the owner approves one specific live post per
   platform.
9. Admin turns on automatic publishing.

## 12. Real-provider smoke policy
No automated test or agent publishes publicly. Private checks first: TikTok Direct Post with
SELF_ONLY privacy (unaudited apps are private-only) or inbox upload; Facebook Page post created
unpublished (`published=false`) and deleted; Instagram container creation without
`media_publish` (verifies media fetch and format), then expiry; Google: list locations only. A
public post happens only after the owner approves that exact post in chat.
