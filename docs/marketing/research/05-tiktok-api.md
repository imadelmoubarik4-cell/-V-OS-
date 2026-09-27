# 05 — TikTok Content Posting API (provider documentation for Atlas S94)

Access date for every source: **2026-09-26**.

## 0. How this was researched (read first)

- **Direct fetch of developers.tiktok.com was blocked** in this sandbox:
  - `WebFetch https://developers.tiktok.com/doc/content-posting-api-reference-direct-post` → `EGRESS_BLOCKED (developers.tiktok.com)`.
  - `curl https://developers.tiktok.com/...` → `CONNECT tunnel failed, response 403`. `open.tiktokapis.com`, `web.archive.org`, `r.jina.ai` also unreachable.
- Only `WebSearch` restricted to `allowed_domains=["developers.tiktok.com"]` worked. It returns search-engine extracts of the official pages, not the raw pages.
- Evidence tags used below:
  - **[V]** = statement came back in a WebSearch extract attributed to the cited developers.tiktok.com page (primary source, but seen via the search engine's extract, not the rendered page).
  - **[UNVERIFIED]** = from prior knowledge of the TikTok docs; could NOT be confirmed in this session. **Recheck on the live page before shipping code or UX that depends on it.**
- Atlas code inspected (read only): `/home/user/-V-OS-/.claude/worktrees/s94/supabase/functions/atlas-integrations/providers.mjs` lines 153-181, 501-580.

## Sources (all accessed 2026-09-26)

| Key | URL |
|---|---|
| GS-DP | https://developers.tiktok.com/docs/en/content-posting-api-get-started |
| REF-DP | https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post |
| GS-UP | https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content |
| REF-UP | https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video |
| CI | https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info |
| ST | https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status |
| MTG | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide |
| PH | https://developers.tiktok.com/doc/content-posting-api-reference-photo-post |
| CSG | https://developers.tiktok.com/docs/en/content-sharing-guidelines |
| SC | https://developers.tiktok.com/docs/en/scopes-overview , https://developers.tiktok.com/doc/tiktok-api-scopes |
| TOK | https://developers.tiktok.com/docs/en/oauth-user-access-token-management |
| LK-W | https://developers.tiktok.com/docs/en/login-kit-web , https://developers.tiktok.com/doc/login-kit-desktop/ |
| RL | https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit |
| ERR | https://developers.tiktok.com/doc/tiktok-api-v2-error-handling |
| WH | https://developers.tiktok.com/doc/webhooks-overview/ , https://developers.tiktok.com/doc/webhooks-events/ |
| AR | https://developers.tiktok.com/docs/en/app-review-guidelines , https://developers.tiktok.com/docs/en/getting-started-faq |

---

## 1. Auth (Login Kit, OAuth v2)

- Login Kit is TikTok's OAuth 2.0 implementation, based on RFC 6749. [V, TOK/LK]
- **Authorize:** `GET https://www.tiktok.com/v2/auth/authorize/` with `client_key`, `scope` (comma-separated), `response_type=code`, `redirect_uri`, `state`. [UNVERIFIED param list; endpoint matches Atlas code and TOK]
- **Token:** `POST https://open.tiktokapis.com/v2/oauth/token/` [V, TOK], `Content-Type: application/x-www-form-urlencoded`, body `client_key, client_secret, code, grant_type=authorization_code, redirect_uri` (+ `code_verifier` for PKCE platforms).
- **Refresh:** same endpoint, `grant_type=refresh_token, refresh_token, client_key, client_secret`. Access token "can be refreshed without user consent". [V, TOK] The response may return a **new refresh_token**; always persist it. [UNVERIFIED]
- **Revoke:** `POST https://open.tiktokapis.com/v2/oauth/revoke/` with `client_key, client_secret, token`. [UNVERIFIED; matches Atlas code]
- **PKCE:** required for Desktop/iOS/Android, **not for Web**. Web uses `state` + a server-side client secret (confidential client). [V, LK-W] Note that TikTok's `code_challenge` is **hex-encoded SHA-256**, not base64url like RFC 7636. [V, LK desktop] Atlas's `pkce: "none"` for a server-side web flow is consistent with this.
- **Lifetimes:** `expires_in = 86400` (access token, 24 h). `refresh_expires_in = 31536000` (refresh token, 365 days). [V, TOK]
- Token response also carries `open_id`, `scope` (comma list), `token_type`. [UNVERIFIED field list; Atlas reads these]

## 2. Scopes

| Scope | Enables | Evidence |
|---|---|---|
| `user.info.basic` | `/v2/user/info/` limited to `open_id, union_id, avatar_url, avatar_url_100, avatar_large_url, display_name` | [V, SC] |
| `video.publish` | **Direct Post** (video and photo) to the creator's profile: creator_info query, `/video/init/`, `/content/init/` with `post_mode=DIRECT_POST`, status fetch | [V, GS-DP] |
| `video.upload` | **Inbox Upload** (draft): `/v2/post/publish/inbox/video/init/` and `/content/init/` with `post_mode=MEDIA_UPLOAD`. User must open the inbox notification in TikTok to finish the post | [V, GS-UP/REF-UP] |
| `video.list` | Read the user's public videos (not needed to publish) | [UNVERIFIED] |

Atlas today requests only `user.info.basic`. It lists `video.upload, video.publish, video.list` as `future_scopes`. Adding these requires re-consent: tokens only carry the scopes granted at authorize time.

## 3. Direct Post flow (video)

**Step 1: Query Creator Info** (required each time the post screen is rendered) [V, CI]
```
POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/
Authorization: Bearer {access_token}
Content-Type: application/json; charset=UTF-8
```
Response `data` [V, CI]: `creator_avatar_url`, `creator_username` [UNVERIFIED], `creator_nickname`, `privacy_level_options` (e.g. `["PUBLIC_TO_EVERYONE","MUTUAL_FOLLOW_FRIENDS","FOLLOWER_OF_CREATOR"*,"SELF_ONLY"]`), `comment_disabled`, `duet_disabled`, `stitch_disabled`, `max_video_post_duration_sec`. (*FOLLOWER_OF_CREATOR is [UNVERIFIED].)
Rate limit: **20 req/min per access_token**. [V, CI]
If this returns a "can't post now" error (for example `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting` or `reached_active_user_cap`), block the post and show the user a message. [UNVERIFIED codes]

**Step 2: Init** [V, REF-DP]
```
POST https://open.tiktokapis.com/v2/post/publish/video/init/
Authorization: Bearer {access_token}
Content-Type: application/json; charset=UTF-8
{
  "post_info": {
    "title": "caption #tags @mentions",
    "privacy_level": "<one of creator_info.privacy_level_options>",
    "disable_duet": false,
    "disable_comment": false,
    "disable_stitch": false,
    "video_cover_timestamp_ms": 1000,
    "brand_content_toggle": false,     // [UNVERIFIED name] paid partnership / branded content
    "brand_organic_toggle": false,     // [UNVERIFIED name] "Your brand"
    "is_aigc": false                   // [UNVERIFIED] AI-generated label
  },
  "source_info": {
    "source": "FILE_UPLOAD",           // or "PULL_FROM_URL"
    "video_size": 50000123,
    "chunk_size": 10000000,
    "total_chunk_count": 5
    // PULL_FROM_URL instead: "video_url": "https://verified.prefix/…/v.mp4"
  }
}
```
Response `data`: `publish_id` and (FILE_UPLOAD only) `upload_url`. [V]
Rate limit: **6 req/min per access_token**. [V]
`title` max **2200 UTF-16 runes**. [UNVERIFIED; the search could not confirm it]

**Step 3 (FILE_UPLOAD): PUT chunks** to `upload_url`. See §4.

**Step 4: Poll status.** See §6.

**Inbox (draft) variant:** `POST /v2/post/publish/inbox/video/init/` with only `source_info` (no post_info). Needs `video.upload`. Limit 6/min. [V endpoint; body UNVERIFIED]

## 4. Media transfer: FILE_UPLOAD vs PULL_FROM_URL [MTG, REF-UP]

**FILE_UPLOAD** [V unless noted]
- Each chunk must be **≥5 MB and ≤64 MB**. The **final chunk may be larger than chunk_size, up to 128 MB**, to absorb trailing bytes.
- `total_chunk_count = floor(video_size / chunk_size)`.
- A video **<5 MB** is uploaded whole, with `chunk_size = video_size`.
- A video **>64 MB** must be uploaded in multiple chunks. Chunk count ranges from **1 to 1000**. Chunks must be sent **sequentially**.
- `upload_url` is **valid for 1 hour**. Use the whole URL, including its query params.
- Request per chunk:
  ```
  PUT {upload_url}
  Content-Type: video/mp4          (or video/quicktime, video/webm)
  Content-Length: {bytes in this chunk}
  Content-Range: bytes {first}-{last}/{total}
  <binary>
  ```
- The response header `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}` reports progress. The final chunk returns 201 and partial chunks return 206. [status codes UNVERIFIED]

**PULL_FROM_URL** [V]
- Use it when the media already sits in server-side storage. TikTok downloads it.
- The URL must be under a **domain or URL prefix that the app has verified** through "Manage URL properties" in the TT4D app on the Manage Apps page.
  - A domain is verified by adding a signature string to its **DNS** records. Once verified, all paths on that domain and its subdomains count as owned.
  - A URL prefix is `https:// + host + path + /`. The host must be a domain, not an IP. Only URLs with that exact prefix count. For example, a verified `https://example.com/videos/user/` covers `/videos/user/123/x.mp4` but not `/videos/2023/user/...`.
- The URL must be **https** and **must not redirect**.
- Atlas implication: Supabase Storage signed URLs on `*.supabase.co` cannot be DNS-verified by us. We need either a custom domain we control (DNS TXT), verified as a URL prefix on a host we own, or FILE_UPLOAD. Signed URLs typically carry query params and must not 302. An unverified URL gives error `url_ownership_unverified` [UNVERIFIED code name].

## 5. Photo posts [PH]

```
POST https://open.tiktokapis.com/v2/post/publish/content/init/
{
  "post_info": {
    "title": "…", "description": "…",
    "disable_comment": false,
    "privacy_level": "PUBLIC_TO_EVERYONE",
    "auto_add_music": true,            // [UNVERIFIED]
    "brand_content_toggle": false, "brand_organic_toggle": false   // [UNVERIFIED]
  },
  "source_info": {
    "source": "PULL_FROM_URL",
    "photo_cover_index": 0,
    "photo_images": ["https://verified.prefix/1.webp", "https://verified.prefix/2.jpg"]
  },
  "post_mode": "DIRECT_POST",          // or "MEDIA_UPLOAD" (inbox/draft)
  "media_type": "PHOTO"
}
```
- `post_mode` and `media_type` are required. [V]
- Examples use `PULL_FROM_URL` and WEBP. [V] Photos are **PULL_FROM_URL only**, with no FILE_UPLOAD. [UNVERIFIED]
- In the UX, only "Allow Comment" applies to photos. Duet and Stitch do not. [V, CSG]
- Limits [all UNVERIFIED; the "photo restrictions" section was not retrievable]:
  - formats JPEG and WEBP (no PNG)
  - ≤20 MB per image
  - max 1080p
  - up to 35 images
  - `title` ≤90 UTF-16 runes, `description` ≤4000 runes
- A failure example shows `fail_reason: "picture_size_check_failed"`. [V, ST]

## 6. Status polling [ST]

```
POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
Authorization: Bearer {access_token}
{"publish_id": "v_pub_file~v2-1.123"}
```
- Rate limit **30 req/min per token**. [V]
- Response `data`: `status`, `fail_reason`, `publicaly_available_post_id` (array, with TikTok's misspelling), `uploaded_bytes`. [V] `downloaded_bytes` also appears for pulls. [UNVERIFIED]
- `status` values: `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX` (inbox flow), `PUBLISH_COMPLETE`, `FAILED`. [UNVERIFIED as a list; only FAILED was seen in the extracts. These are the names in the official enum as last known.]
- **post_id semantics** [V]:
  - Public posts go through moderation, and TikTok does **not return the post_id until moderation completes**. That is usually <1 min, sometimes a few hours.
  - So `PUBLISH_COMPLETE` can arrive with an **empty** `publicaly_available_post_id`. [UNVERIFIED nuance]
  - SELF_ONLY posts never get a public id. [UNVERIFIED]
  - Keep polling or use webhooks. Do not treat an empty id as a failure.
- `fail_reason` values [UNVERIFIED list, except picture_size_check_failed which is V]:
  - `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed`, `internal`
  - `video_pull_failed`, `photo_pull_failed`, `publish_cancelled`, `auth_removed`
  - `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk`

## 7. Unaudited clients and the audit [GS-DP, CSG, AR]

- **Unaudited API clients can only post with SELF_ONLY visibility.** An audit is needed to lift this. [V]
- Unaudited limits [UNVERIFIED specifics]:
  - at most ~5 distinct creators posting per 24 h
  - the target account must be **private** at post time (error `unaudited_client_can_only_post_to_private_accounts`)
  - every post is forced to SELF_ONLY
- Audited and unaudited clients both face a **24-h active-creator cap**, set by the audit application, and a **per-creator daily post cap**. The search extract said this is "typically around 15/day". [partially V; treat the number as UNVERIFIED]
- The audit is requested in the developer portal for the Content Posting API. It checks for the §8 UX, usually with a screen recording, plus ToS compliance. App review for Login Kit/scopes is separate. [UNVERIFIED process detail]

## 8. Mandatory UX (Content Sharing Guidelines) [CSG]

1. **Get fresh creator_info every time** the post page renders. Use it for privacy options and interaction settings. [V]
2. **Show the creator's nickname**, so users know which account the content goes to. The avatar is also returned. [V]
3. **Privacy level:** offer only values from `privacy_level_options`. [V] **No default**: the user must pick one manually. [UNVERIFIED wording; widely enforced in audits] Errors such as `privacy_level_option_mismatch` come back if they do not match. [UNVERIFIED code]
4. **Interactions (Comment / Duet / Stitch):** the user turns them on manually, and **none are checked by default**. If creator_info says one is disabled, grey out and disable that checkbox. Photos show Comment only. [V]
5. **Max duration:** check the video duration against `max_video_post_duration_sec` before posting. [V]
6. **Commercial content disclosure:** a toggle that is **off by default**. [V] When on, it shows the checkboxes "Your brand" and "Branded content". [V]
   - "Your brand" means promoting yourself or your own business. It becomes Brand Organic and is labelled **"Promotional content"**. [V]
   - "Branded content" means promoting a third party. It becomes Branded Content and is labelled **"Paid partnership"**. [V]
   - Branded content cannot be private. Either disable "Only me" with the hover text "Branded content visibility cannot be set to private.", or switch visibility to public. [V]
   - With the toggle on, at least one box must be checked before posting. [UNVERIFIED]
7. **Consent text** above the Post button [V]:
   - Default, or "Your brand" only: "By posting, you agree to TikTok's Music Usage Confirmation."
   - "Branded content" checked: "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
   - Each link goes to TikTok's policy page. [UNVERIFIED]
8. **Preview** the content before posting. [V] Posting requires **explicit user consent**: the user presses post after seeing the metadata. [V, GS-DP]
9. **Processing notice:** tell users it may take a few minutes for the content to process and appear on their profile. Poll status or use webhooks. [V]
10. **No added branding:** do not superimpose any brand name, logo, watermark, promotional link or text on the shared content. [V] Atlas must not stamp "Atlas" or other app branding. The venue's own footage is fine and is disclosed as "Your brand".
11. Users must be able to edit the title/caption. Do not pre-fill hashtags the user cannot remove. [UNVERIFIED]

**Atlas note:** "approved content published on behalf of the venue" still needs a **human at post time** to go through items 1-9 with fresh creator_info. A fully unattended scheduled Direct Post is at odds with the guidelines and is an audit risk. [interpretation]

## 9. Video constraints [UNVERIFIED unless noted]

- Format: MP4 with H.264 confirmed as supported. [V, MTG] WebM and MOV are also accepted.
- Codecs: H.264 is recommended; H.265, VP8 and VP9 are accepted.
- Size: max **4 GB**.
- Duration: no longer than the creator's `max_video_post_duration_sec`. [V check] The platform maximum is up to 10 min, and the per-creator value can be lower.
- Frame rate: **23-60 FPS**.
- Resolution: **360-4096 px** on each side.

## 10. Rate limits [RL]

- One-minute sliding window. Over the limit you get **HTTP 429 `rate_limit_exceeded`**. [V]
- Per access_token [V]:
  - creator_info: 20/min
  - video/init, inbox/video/init, content/init: 6/min
  - status/fetch: 30/min
- Default for other endpoints: 600/min. [UNVERIFIED]

## 11. Idempotency and duplicates

- **No documented idempotency key.** Each successful `init` creates a new `publish_id` and a new post. [UNVERIFIED as "absent"; nothing found]
- There is no documented "list my publish_ids" endpoint, so a lost init response cannot be reconciled through the API.
  - `video.list` can list the user's public videos afterwards, but not SELF_ONLY ones or ones still in moderation.
- Recommended Atlas design:
  1. Persist the job as `initiating` before calling init, and persist `publish_id` as soon as it arrives.
  2. If the init response is lost (timeout or 5xx), **do not auto-retry**. Mark the job `unknown_outcome` and ask a human. Optionally check with `video.list` after moderation.
  3. Retry only on explicit 4xx validation errors and on 429 (which means not created).
  4. Re-PUT a chunk with the same `upload_url` inside its 1 h window. This retries the chunk, not the post.
- Store `publish_id` → our post id so webhook and poll updates are idempotent.

## 12. Error format and classification [ERR]

- v2 errors: `{"error": {"code": "<string>", "message": "...", "log_id": "..."}}`, with `code:"ok"` on success. [V] Quote `log_id` when contacting TikTok support. [V]
- Classification [codes UNVERIFIED]:

| Class | Codes | Action |
|---|---|---|
| Auth | `access_token_invalid` (401), `scope_not_authorized` (401), `scope_permission_missed` | Refresh, else reconnect (re-consent for new scopes) |
| Validation | `invalid_param` (400), `privacy_level_option_mismatch` (403), `url_ownership_unverified` (403), `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed` | Fix input; do not retry as-is |
| Policy / cap | `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`, `unaudited_client_can_only_post_to_private_accounts` (403) | Stop and show a message. Retry after 24 h at the earliest |
| Throttle | `rate_limit_exceeded` (429) | Back off (sliding 1 min) |
| Transient | `internal_error` (5xx), `video_pull_failed`, `photo_pull_failed` | See §11 for init. Pull failures can be re-initiated once we are sure no post was created (status = FAILED) |

## 13. Webhooks [WH]

- HTTPS POST with a JSON body to the app's callback URL, set in the Developer Portal. [V]
- Retries for up to **72 h** with exponential backoff, then dropped. [V]
- The Content Posting webhooks report the final outcome of a post. [V]
- Event names: `post.publish.failed` (formerly `video.upload.failed`) and `post.publish.complete` (formerly `video.publish.complete`). [V]
- Also `post.publish.inbox_delivered`, `post.publish.publicly_available` (carries post_id after moderation) and `post.publish.no_longer_publicaly_available`. [UNVERIFIED]
- Payload includes `client_key, event, create_time, user_openid, content` (a JSON string with `publish_id`, `publish_type`, `post_id`/`reason`). It is signed via the `TikTok-Signature` header (HMAC-SHA256 with client_secret over `timestamp.body`). [UNVERIFIED]
- Useful because moderation can take hours. Use them together with bounded polling.

## 14. Gap vs current Atlas code

- Scopes are `["user.info.basic"]` only. Publishing needs `video.publish` (Direct Post) and/or `video.upload` (inbox), each approved in the app and granted by the user.
- The token, refresh, revoke and user/info endpoints and the form encoding match the docs. The refresh path already keeps a rotated `refresh_token`. Good.
- `verifyTikTok` asks for `open_id,display_name` fields, which are within `user.info.basic`. [V]
- No creator_info, init, upload, status or webhook code exists yet. No URL-prefix verification exists yet for PULL_FROM_URL.
