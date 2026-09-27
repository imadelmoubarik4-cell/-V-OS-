# 04 — Meta (Facebook Pages + Instagram) publishing: provider matrix for Atlas S94

Access date for every source below: **2026-09-26**.

## 0. How this was verified (read first)

- `WebFetch` and `curl` to `developers.facebook.com` and `graph.facebook.com` were **blocked by the sandbox egress proxy** (`EGRESS_BLOCKED` / `CONNECT 403`, org policy). No official page body could be read directly.
- What worked: `WebSearch` restricted to `allowed_domains=["developers.facebook.com"]`. Its results are summaries of the official pages, not the full text.
- Labels used in this file:
  - **[S]** = confirmed from a developers.facebook.com page through a domain-restricted search summary. The URL is given. Treat it as primary-sourced, but re-check the exact wording before hard-coding anything.
  - **UNVERIFIED** = not confirmed from an official page in this session (the search returned nothing, or returned something ambiguous or contradictory). These values come from prior knowledge or are inferred. They must be confirmed by opening the page in a browser before shipping.
- Before implementation, a human (or an unblocked session) should open each URL marked ★ and confirm the value.

## 1. What Atlas does today (from repo, read-only)

`supabase/functions/atlas-integrations/providers.mjs`:
- `DEFAULT_META_GRAPH_VERSION = "v25.0"`. It can be overridden through env (`metaVersion(env)`).
- Auth: manual login flow `https://www.facebook.com/{v}/dialog/oauth` with `scope=` (classic Facebook Login style, not `config_id`). Token exchange goes to `graph.facebook.com/{v}/oauth/access_token`. No PKCE. `refresh: null`.
- Facebook scopes requested: `pages_show_list, pages_read_engagement`. Future scopes: `pages_manage_posts, read_insights, business_management`.
- Instagram scopes requested: `instagram_basic, pages_show_list`. Future scopes: `instagram_content_publish, instagram_manage_insights, pages_read_engagement, business_management`.
- IG discovery: `GET me/accounts?fields=name,instagram_business_account{id,username}`. The code picks `linked[0]`, which is an issue: with several Pages it needs a picker.
- Facebook and Instagram are two separate OAuth connections that use the same Meta app. **Recommendation:** use one Meta connection that yields both the Page token and the IG user ID. They share the same user token and Page.

## 2. Auth method: recommendation

| Option | Fits a venue with FB Page linked to IG professional account? | Notes |
|---|---|---|
| **Facebook Login for Business + "Instagram API with Facebook Login"** | **Yes — recommended** | One login gives the Page token and the linked `instagram_business_account`. It requires the IG account to be linked to a Page, and the user must be able to perform admin-equivalent tasks on that Page [S]. Resumable (rupload) IG uploads are available only on this path [S]. |
| Instagram API with Instagram Login (`graph.instagram.com`) | Works, but IG only | Needs no Facebook Page [S]. You would still need Facebook Login for the Page. Two logins, two token systems. |
| Classic Facebook Login (`scope=`) | Works technically | Facebook Login for Business with `config_id` is Meta's "preferred" solution for tech providers [S]. `config_id` and `scope` are not interchangeable [S]. |

Token type under Facebook Login for Business [S]:
- A **User access token** fits apps that act in real time on user input, "e.g. click a button to post to their Page".
- A **Business Integration System User (BISU) token** fits "programmatic, automated actions on your business clients' assets without having to rely on input from an app user, or require re-authentication".
- **Atlas publishes at a scheduled time with no user present, so BISU tokens are the better fit.** Fallback: a long-lived user token, then a Page token (non-expiring, see §5).

Source: ★ https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business ; https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login ; https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/ ; https://developers.facebook.com/docs/instagram-platform/overview/

## 3. Graph API version & deprecation

| Item | Value | Status |
|---|---|---|
| v25.0 released | 2026-02-18 (blog "Introducing Graph API v25.0") | [S] https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25/ |
| **v26.0 released (current latest)** | 2026-07-29 (blog "Introducing Graph API v26.0") | [S] https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/ ; reference pages now show "Graph API Reference v26.0" [S] |
| v24.0 released | 2025-10-08 | [S] blog URL https://developers.facebook.com/blog/post/2025/10/08/introducing-graph-api-v24-and-marketing-api-v24/ |
| v23.0 released | 2025-05-29 | [S] https://developers.facebook.com/blog/post/2025/05/29/introducing-graph-api-v23-and-marketing-api-v23/ |
| Deprecation rule | Each version works for at least 2 years. It stops being usable 2 years after the **next** version is released. | [S] https://developers.facebook.com/docs/graph-api/guides/versioning/ |
| v25.0 expiry | Derived from the rule: about **2028-07-29** (2 years after v26.0). Exact date is on the versions table. | **UNVERIFIED** exact date ★ https://developers.facebook.com/docs/graph-api/changelog/versions/ |
| v26.0 breaking changes for Pages/IG | Not readable | **UNVERIFIED** ★ https://developers.facebook.com/docs/graph-api/changelog/version26.0/ |

Recommendation: keep the version configurable (already done). Move the default to v26.0 after reading the v26.0 changelog for Pages/IG/Video changes.

## 4. Permissions

### Facebook Page publishing
| Permission | Needed for | Status |
|---|---|---|
| `pages_show_list` | List the Pages the user can act on (`/me/accounts`) | [S] required in the "Manage everything on your Page" use case |
| `pages_manage_posts` | Create, edit and delete Page posts, photos and videos | [S] named in the Pages API getting-started guide |
| `pages_read_engagement` | Read Page content and metadata; commonly required together with `pages_manage_posts` | [S] listed. Its formal status as a *dependency* is **UNVERIFIED** ★ https://developers.facebook.com/docs/permissions/ |
| `business_management` | Auto-added and not removable in the "Manage everything on your Page" use case. Needed when Pages are owned by a Business portfolio. | [S] https://developers.facebook.com/documentation/pages-api/create-an-app |
| `pages_manage_metadata` | Webhook subscription (`/{page-id}/subscribed_apps`), settings | [S] listed in getting-started. Optional for pure publishing. |
| `public_profile` | default | [S] |

### Instagram (via Facebook Login)
For content management, the app dashboard adds these by default as **required**: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, `pages_show_list`, `business_management` [S].
Source: https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app/ ; ★ https://developers.facebook.com/docs/permissions/reference/instagram_content_publish/

**Combined Atlas scope set:** `pages_show_list, pages_read_engagement, pages_manage_posts, business_management, instagram_basic, instagram_content_publish`. Add `pages_manage_metadata` if webhooks are used. Insights scopes are out of scope for publishing.

## 5. Account prerequisites & tokens

**Prerequisites**
- FB Page: the user must be able to perform the **CREATE_CONTENT** task on the Page. The `tasks` field on `/me/accounts` returns `MANAGE, CREATE_CONTENT, MODERATE, ADVERTISE, ANALYZE` [S]. Gate the Page picker on `CREATE_CONTENT` ∈ tasks.
- IG: the account must be an Instagram **Business or Creator** (professional) account **linked to the FB Page**. The user must be able to perform admin-equivalent tasks on that Page [S].

**Token lifetimes** [S] https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
| Token | Lifetime | Status |
|---|---|---|
| Short-lived user token | about 1–2 h | **UNVERIFIED** exact figure; the page implies "short-lived" |
| Long-lived user token | about **60 days**. It is refreshed at most once per day when the person makes a request; otherwise it expires after about 60 days. | [S] |
| Exchange | `GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token=<short>` | [S] |
| Page token from a **short-lived** user token | about 1 h | [S] |
| Page token from a **long-lived** user token | **No expiration date**. Invalidated by password change, lost Page role, app de-authorisation, etc. | [S] |
| BISU token (FL4B) | Does not require re-authentication; intended for automated actions | [S]. Exact lifetime is **UNVERIFIED** ★ https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/ |
| Refresh | No OAuth refresh_token. Re-exchange the long-lived token, or re-auth. Detect error 190 and prompt reconnect. | [S]/inferred |

IG calls under Facebook Login use the **Page access token or user token** against `graph.facebook.com/{v}/{ig-user-id}/...`. Which token is required per IG edge is **UNVERIFIED** (commonly the user token or the Page token; test both).

## 6. Listing selectable accounts

```
GET /{v}/me/accounts?fields=id,name,tasks,access_token,instagram_business_account{id,username,profile_picture_url}
```
- `/{user_id}/accounts` returns the IDs and Page tokens for Pages where the user can perform a task [S].
- Filter: `tasks` contains `CREATE_CONTENT` (FB). `instagram_business_account` must be present (IG).
- Paginate with `paging.next`. Pages owned by a Business portfolio may need `business_management`, e.g. `/{business_id}/owned_pages`. Behaviour when /me/accounts is empty is **UNVERIFIED**.
- Replace the `linked[0]` logic in `providers.mjs` with an explicit picker.

## 7. Facebook publishing flows (Page token; `graph.facebook.com/{v}`)

| Flow | Endpoint & params | Status |
|---|---|---|
| Text / link post | `POST /{page-id}/feed` with `message`, optional `link` | [S] https://developers.facebook.com/docs/pages-api/posts/ |
| Single photo | `POST /{page-id}/photos` with `url` (public) or multipart `source`, plus `message` (caption). Returns `id` and `post_id`. | Endpoint [S] https://developers.facebook.com/docs/graph-api/reference/page/photos/ ; exact field names **UNVERIFIED** |
| Multi-photo | 1) For each image: `POST /{page-id}/photos` with `published=false`, keep `id`. 2) `POST /{page-id}/feed` with `message` and `attached_media=[{"media_fbid":"<id1>"},{"media_fbid":"<id2>"}]` | [S] |
| Video (non-Reel) | `POST /{page-id}/videos` with `file_url` or an upload handle, plus `description` and `title`. URL or multipart: **≤1 GB, ≤20 min**. Resumable: **≤1.5 GB, ≤45 min**. Resumable upload: `GET /upload:<session>` returns `file_offset` for resuming. | [S] https://developers.facebook.com/docs/video-api/guides/publishing/ ; https://developers.facebook.com/docs/graph-api/guides/upload/ |
| Reels | 1) `POST /{page-id}/video_reels?upload_phase=start` returns `video_id` and `upload_url`. 2) `POST https://rupload.facebook.com/video-upload/{v}/{video_id}` with header `Authorization: OAuth <page_token>`, `offset: 0`, `file_size: <bytes>`, binary body (or header `file_url: <public url>`). 3) `POST /{page-id}/video_reels?upload_phase=finish&video_id=..&video_state=PUBLISHED&description=..`. 4) Poll `GET /{video_id}?fields=status`. | Phases, rupload host and `video_state=PUBLISHED` [S] https://developers.facebook.com/docs/video-api/guides/reels-publishing/ ; header names and status polling **UNVERIFIED** |
| FB Reel specs | 9:16 recommended [S]. Duration (commonly 3–90 s), resolution and fps are **UNVERIFIED** ★ | |
| Native FB scheduling (not used; Atlas schedules) | `published=false` and `scheduled_publish_time=<unix>`, allowed window **10 min to 6 months** ahead. Editable or deletable until 3 min before. List with `GET /{page-id}/scheduled_posts`. | [S] https://developers.facebook.com/docs/graph-api/reference/page/scheduled_posts/ |

## 8. Instagram publishing flows (`graph.facebook.com/{v}/{ig-user-id}`)

Two steps: create a container, then publish it.

| Flow | Endpoint & params | Status |
|---|---|---|
| Image | `POST /{ig-user-id}/media` with `image_url=<public JPEG>`, `caption`, optional `user_tags`, `alt_text`, returns `{id: container}`. Then `POST /{ig-user-id}/media_publish?creation_id=<container>` returns `{id: ig-media-id}` | [S] https://developers.facebook.com/docs/instagram-platform/content-publishing/ ; `alt_text` is **UNVERIFIED** |
| Carousel | 1) For each item: `POST /media` with `is_carousel_item=true` and `image_url` or `video_url` (+`media_type=VIDEO`). 2) `POST /media` with `media_type=CAROUSEL`, `children=<id1,id2,…>`, `caption`. 3) `media_publish`. **Max 10 items**, images and videos may be mixed. The carousel counts as **1 post**. All items are cropped to the first item's ratio (1:1 default). | [S] |
| Reel / video | `POST /media` with `media_type=REELS`, `video_url` (or resumable), `caption`, optional `share_to_feed`, `cover_url`, `thumb_offset`. Poll status, then `media_publish`. The legacy `media_type=VIDEO` is now used only for carousel items. | REELS [S]; `share_to_feed`/`cover_url` are **UNVERIFIED** |
| Story (optional) | `POST /media` with `media_type=STORIES`, `image_url` or `video_url`, then `media_publish`. No stickers (link, poll, location). Mentions without a sticker are OK. Stories expire after 24 h. Returned `media_type` reads IMAGE/VIDEO. | [S] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/stories/ |
| Resumable upload (rupload) | `POST /media` with `media_type=REELS` (or VIDEO/STORIES) and `upload_type=resumable` returns the container id. Then `POST https://rupload.facebook.com/ig-api-upload/{v}/{container-id}` with headers `Authorization: OAuth <token>`, `offset: 0`, `file_size: <bytes>`, and the binary body. **Facebook Login for Business apps only.** | [S] https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads/ ; path version segment **UNVERIFIED** |
| Public URL requirement | Media must be on a **publicly accessible server at publish time**, because Instagram cURLs it. Images have no binary upload option; use Supabase Storage signed or public URLs with long enough TTL. | [S] |

**Container status** — `GET /{container-id}?fields=status_code` [S] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container/

| status_code | Meaning |
|---|---|
| `EXPIRED` | Not published within **24 h** |
| `ERROR` | Failed to complete publishing (read the `status` field for detail; that field name is **UNVERIFIED**) |
| `FINISHED` | Ready to publish |
| `IN_PROGRESS` | Still processing |
| `PUBLISHED` | Already published |

Polling guidance: **once per minute, for no more than 5 minutes** [S]. Atlas should create containers shortly before the scheduled time, and never more than 24 h ahead.

**Publishing limit** [S] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/
- **100 API-published posts per 24 h moving window** per IG account. A carousel counts as 1. The limit is enforced on `media_publish`.
- `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config` returns the usage. The field names are **UNVERIFIED**.
- Meta recommends the app enforce the limit itself, especially for schedulers [S].
- Whether stories count toward the 100 is **UNVERIFIED**.

**Media requirements** [S] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- Image:
  - **JPEG only**
  - ≤ **8 MB**
  - aspect **4:5 – 1.91:1**
  - width 320–1440 (auto-scaled)
  - sRGB (converted)
- Reel:
  - MOV/MP4, no edit lists, moov atom at front
  - HEVC or H.264, progressive, closed GOP, 4:2:0
  - 23–60 fps
  - max 1920 columns
  - aspect 0.01:1–10:1 (9:16 recommended)
  - ≤25 Mbps VBR
  - AAC ≤48 kHz, 1–2 ch, 128 kbps
  - **3 s – 15 min**
  - **≤300 MB**
- Reel cover: JPEG, ≤8 MB, sRGB, 9:16.
- One search summary gave "8 MB" for Reels; a more specific query returned 300 MB. Treat 300 MB as correct, but ★ confirm.
- Carousel-video and story-video specs (for example the 60 s story limit) are **UNVERIFIED** ★.

**Caption limits** [S]: **≤2,200 characters**, **≤30 hashtags**. The @mention cap (commonly 20) is **UNVERIFIED**.

## 9. Idempotency / lost-response recovery

Meta documents **no idempotency key** for `/feed`, `/photos`, `/media` or `media_publish`. This is **UNVERIFIED** as an explicit statement; none was found. Recommended Atlas design:

- **IG:**
  - Persist `container_id` before calling `media_publish`.
  - After a timeout or lost response, `GET /{container_id}?fields=status_code`.
  - If it is `PUBLISHED` [S], treat the post as done. Find the media by `GET /{ig-user-id}/media?fields=id,caption,timestamp,permalink&limit=10` and match on caption and timestamp.
  - If it is `FINISHED`, retrying `media_publish` is safe.
  - Never create a second container for the same Atlas post while the first is unresolved.
- **FB:**
  - No container stage.
  - After a lost response, `GET /{page-id}/feed` or `/published_posts?fields=id,message,created_time&since=<attempt_ts-60>` and match on an Atlas marker, such as the exact message hash, before retrying.
  - For multi-photo: persist the unpublished photo ids. Re-use them rather than re-uploading.
  - For Reels: persist `video_id` after `start`. Check `GET /{video_id}?fields=status` before `finish`.

## 10. Error classification

Source: ★ https://developers.facebook.com/docs/graph-api/guides/error-handling/ and https://developers.facebook.com/docs/graph-api/overview/rate-limiting/. Meta says to branch on `code`, `error_subcode` and the payload, never on the message text [S].

| Class | Codes | Action | Status |
|---|---|---|---|
| Rate limit (app) | `4` | backoff, then retry later | [S] |
| Rate limit (user) | `17` | backoff | **UNVERIFIED** (well-known) |
| Rate limit (Page) | `32` | backoff | [S] |
| Business Use Case rate limit | `80001` (Pages), `80002` (IG), and the rest of the 8000x range; read the `X-Business-Use-Case-Usage` header | backoff until `estimated_time_to_regain_access` | 80001 [S]; others **UNVERIFIED** |
| Custom / throttled | `613` | backoff | **UNVERIFIED** |
| Auth expired / invalid | `190` (subcodes 458 app removed, 460 password changed, 463 expired, 467 invalid) | mark connection `reauthorize`, do not retry | **UNVERIFIED** (well-known) |
| Legacy session | `102` | reauthorize | **UNVERIFIED** |
| Permission | `10`, `200`–`299` (e.g. `200` permissions error) | surface "missing permission / Page role", do not retry | 200 [S]; 10 **UNVERIFIED** |
| Invalid parameter | `100` (e.g. "scheduled publish time is invalid") | fix the request, do not retry | [S] (forum titles on the official domain) |
| Transient | `1`, `2` | retry with backoff | **UNVERIFIED** |
| Spam / policy block | `368` | do not retry; tell the user | **UNVERIFIED** |
| IG media errors | Media not ready `9007` / subcode `2207027`, publishing limit reached `2207042`, media fetch or format failures `2207026`/`2207052` etc. | not-ready: wait and re-poll; limit: reschedule after the window; format: fail with reason | **UNVERIFIED** ★ https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes/ |

**IG BUC rate limit** [S]: calls within 24 h = **4800 × number of impressions** of the IG account in the last 24 h. A business-owned app gets its own quota; an app not owned by a business shares the account quota.

## 11. App Review / Business verification / Access levels

- Standard Access covers only accounts with a role on the app. **Advanced Access** is needed to act on other people's or businesses' data. Every app requesting Advanced Access must complete **Business Verification** [S].
- An app used by other businesses must request Advanced Access for every permission it needs [S].
- If the app accesses business assets owned by other business portfolios, it must become a **Tech Provider**, which adds data questions and App Review before publishing [S].
- App Review needs a screencast per permission. Every permission in §4 needs review for Advanced Access. Live mode is required.
- The exact per-permission review requirements are **UNVERIFIED** ★ https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction

Sources: https://developers.facebook.com/docs/permissions/ ; https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business

For a single venue (VÁ) whose own people hold roles on the Meta app, Standard Access may be enough during pilot. Whether that holds when the Page belongs to a separate business portfolio is **UNVERIFIED**.

## 12. Webhooks (optional)

- Pages webhooks: subscribe with `POST /{page-id}/subscribed_apps?subscribed_fields=feed` (Page token, `pages_manage_metadata`). This could confirm that a post appeared, which helps idempotency. `subscribed_fields` has been required since v3.2 [S]. https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages/
- Instagram webhooks: configured in the App Dashboard only, not via API. The object covers media, comments and stories [S]. https://developers.facebook.com/docs/instagram-platform/webhooks
- Not required for publishing. Polling is sufficient.

## 13. Open items to confirm manually (★)

1. Versions table: exact v25.0 and v26.0 expiry dates, and the v26.0 Pages/IG/Video breaking changes.
2. FB Reels specs (duration, resolution) and `video_reels` status polling fields.
3. IG error-code table (9007/2207xxx).
4. The `content_publishing_limit` response fields, and whether stories count toward the limit.
5. The `pages_manage_posts` dependency list in the permissions reference.
6. BISU token lifetime, and whether Atlas qualifies as a Tech Provider.
