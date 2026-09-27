# 06 — Google Business Profile (GBP) API: local posts for Atlas S94

Accessed: 2026-09-26. Author: provider-documentation agent.

## 0. Evidence levels (read first)

`developers.google.com` (and `developers.google.cn`, `support.google.com`, `web.archive.org`) are **blocked by this
session's egress proxy** (WebFetch → `EGRESS_BLOCKED`; curl → `CONNECT tunnel failed, 403`). So:

| Tag | Meaning |
|---|---|
| **[DISC]** | Verified directly from Google's live machine-readable discovery documents (official, fetched 2026-09-26, `revision: 20260923`) or a live probe of the Google endpoint. Strongest. |
| **[IDX]** | Official developers.google.com page, content seen only as WebSearch index excerpts (page itself not fetched). Reliable for the stated fact, not for surrounding nuance. |
| **UNVERIFIED** | From prior knowledge of the official docs; could not be confirmed this session. Must be re-checked against the linked page before shipping. |

The v4 API (`mybusiness.googleapis.com`, where localPosts live) has **no public discovery document**
(`$discovery/rest?version=v4` → 404; not in the Google API directory; not in `google-api-python-client` bundles), so
the LocalPost schema could only be checked via [IDX]. A live unauthenticated probe does confirm the method exists:

```
GET https://mybusiness.googleapis.com/v4/accounts/1/locations/1/localPosts  (2026-09-26)
→ 401 UNAUTHENTICATED, ErrorInfo.reason=CREDENTIALS_MISSING,
  metadata.method = "google.mybusiness.v4.LocalPosts.ListLocalPosts", service = "mybusiness.googleapis.com"   [DISC]
```

## 1. Atlas current state (repo read, not edited)

`supabase/functions/atlas-integrations/providers.mjs` — provider `google-business-profile`:
- OAuth: `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, revoke `https://oauth2.googleapis.com/revoke`; PKCE S256; `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`.
- Scope: `https://www.googleapis.com/auth/business.manage` (only scope; `future_scopes: []`) — **already sufficient for posting**.
- Verify step: `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts`, stores `accounts[0].name` / `accountName`.
- Not wired: location listing/picker, localPosts create/get/list, Pub/Sub. Copy says "Shows your Google reviews and business listing" — no publishing.
- Gap: verify picks `accounts[0]` only; a user can have several accounts (PERSONAL + LOCATION_GROUPs) — picker needed.

## 2. Auth + scope

- Scope: `https://www.googleapis.com/auth/business.manage` (single scope for all GBP APIs incl. v4 localPosts). [IDX: implement-oauth page] — matches Atlas config. It is a sensitive scope → OAuth consent-screen verification for production. UNVERIFIED (Google Cloud policy; not re-fetched).
- Token refresh: standard Google OAuth — `POST https://oauth2.googleapis.com/token` `grant_type=refresh_token`; refresh token only issued with `access_type=offline` (+ `prompt=consent` to re-issue). Access tokens ~1h. UNVERIFIED this session (Google Identity docs blocked); Atlas already implements `refreshGoogle`. Refresh failure `invalid_grant` = revoked/expired → mark connection needs-reauth. Note: apps in "Testing" publishing status get refresh tokens that expire after 7 days (UNVERIFIED).

## 3. Prerequisites

- Apply for Business Profile API access (the "Application for Basic API Access" / GBP API contact form). [IDX: prereqs, faq, limits]
- Requirement for applicant: manage a GBP that is **verified and active for 60+ days**, and the business has a **website** listed on the profile. [IDX: prereqs]
- Review takes up to ~14 days. [IDX: prereqs]
- Until approved, quota shows **0 QPM**; approved projects show **300 QPM**. With 0 QPM, do NOT request a quota increase — submit the access application. [IDX: limits, faq]
- Enable the GBP APIs in the Cloud project: Account Management, Business Information, Google My Business API (v4), Notifications, Verifications, Performance, Q&A, Place Actions, Lodging ("eight APIs" per basic-setup). [IDX: basic-setup]
- The **v4 "Google My Business API" is only visible in Cloud console after approval**. [IDX: prereqs]
- Per-venue: the connecting Google user must have OWNER/MANAGER access on the location's account. `Account.role` enum: `PRIMARY_OWNER | OWNER | MANAGER | SITE_MANAGER`; `permissionLevel`: `OWNER_LEVEL | MEMBER_LEVEL`. [DISC] (Site managers cannot manage posts in the GBP UI — UNVERIFIED for API; treat SITE_MANAGER as "cannot publish" until tested.)
- Location must be verified / have **Voice of Merchant** for posts to appear. `Location.metadata.hasVoiceOfMerchant` [DISC]; details via `GET https://mybusinessverifications.googleapis.com/v1/locations/{id}/VoiceOfMerchantState` → `hasVoiceOfMerchant`, `hasBusinessAuthority`, and one action: `verify | waitForVoiceOfMerchant | resolveOwnershipConflict | complyWithGuidelines`. [DISC]
- `Location.metadata.canOperateLocalPost` is **Deprecated: "no longer populated and will be removed"** — do not use it as an eligibility check. [DISC]

## 4. Account + location picker

1. Accounts [DISC]:
   `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20&pageToken=…`
   (default & max pageSize 20; optional `filter=type=USER_GROUP` — `type` is the only filter; `parentAccount` for orgs/groups). Account fields: `name` (`accounts/{id}`), `accountName`, `type` (`PERSONAL|LOCATION_GROUP|USER_GROUP|ORGANIZATION`), `role`, `permissionLevel`, `verificationState`, `vettedState`.
2. Locations [DISC]:
   `GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/{accountId}/locations?readMask=name,title,storeCode,storefrontAddress,metadata&pageSize=100&pageToken=…`
   - `readMask` **required**; `pageSize` default 10, max 100; `orderBy` in `title`, `store_code`; `filter` per location-data guide.
   - `accounts/-` = the authenticated user, includes directly and indirectly owned locations (useful single call for the picker). A PERSONAL account id returns only directly owned locations.
   - Useful metadata: `placeId`, `mapsUri`, `newReviewUri`, `hasVoiceOfMerchant`, `hasPendingEdits`, `duplicateLocation`.
   - `name` is `locations/{locationId}` (v1). **v4 localPosts need `accounts/{accountId}/locations/{locationId}`** — store both accountId (the account under which the location was listed) and locationId.

## 5. Post creation (v4 — still the only localPosts API)

Methods on `https://mybusiness.googleapis.com/v4/{parent=accounts/*/locations/*}/localPosts` [IDX + live probe]:
- `POST …/localPosts` create (body = LocalPost) → returns LocalPost
- `GET …/localPosts?pageSize=&pageToken=` list
- `GET …/localPosts/{postId}` get
- `PATCH …/localPosts/{postId}?updateMask=` patch
- `DELETE …/localPosts/{postId}` delete
- `reportInsights` — **removed** (change log; use Performance API) [IDX]

LocalPost fields [IDX unless noted]: `name` (output, `accounts/*/locations/*/localPosts/*`), `languageCode`, `summary`, `callToAction{actionType,url}`, `createTime`, `updateTime` (output), `event{title, schedule{startDate,startTime,endDate,endTime}}` (Date = year/month/day, TimeOfDay = hours/minutes/seconds/nanos), `state` (output), `media[]` (MediaItem), `searchUrl` (output), `topicType`, `alertType`, `offer{couponCode, redeemOnlineUrl, termsConditions}`, and newer `recurrenceInfo` (Daily/Weekly/MonthlyOccurrencePattern — "schedule recurring posts by setting RecurrenceInfo when creating a LocalPost", change log 2025) [IDX; exact shape UNVERIFIED].

Topic types: `LOCAL_POST_TOPIC_TYPE_UNSPECIFIED | STANDARD | EVENT | OFFER | ALERT` [IDX].
CallToAction.actionType: `ACTION_TYPE_UNSPECIFIED | BOOK | ORDER | SHOP | LEARN_MORE | SIGN_UP | CALL` [IDX]; `GET_OFFER` was deprecated (UNVERIFIED; OFFER posts use offer fields/button automatically). For `CALL`, **do not set `url`** (uses listing phone) [IDX, localized page excerpt].

Request bodies (shape from posts-data examples [IDX]; required-field rules UNVERIFIED):
```jsonc
// STANDARD ("What's new")
{ "languageCode":"is", "topicType":"STANDARD", "summary":"…",
  "callToAction":{"actionType":"BOOK","url":"https://…"},
  "media":[{"mediaFormat":"PHOTO","sourceUrl":"https://public.cdn/…jpg"}] }
// EVENT — event.title + event.schedule required
{ "languageCode":"is", "topicType":"EVENT", "summary":"…",
  "event":{"title":"Jazz night","schedule":{
     "startDate":{"year":2026,"month":10,"day":3},"startTime":{"hours":20,"minutes":0,"seconds":0,"nanos":0},
     "endDate":{"year":2026,"month":10,"day":3},"endTime":{"hours":23,"minutes":0,"seconds":0,"nanos":0}}},
  "callToAction":{"actionType":"LEARN_MORE","url":"https://…"}, "media":[…] }
// OFFER — event (title + schedule) is ALSO required (offer validity window); no callToAction needed
{ "languageCode":"is", "topicType":"OFFER", "summary":"…",
  "event":{"title":"Happy hour 2-for-1","schedule":{…}},
  "offer":{"couponCode":"HAPPY2","redeemOnlineUrl":"https://…","termsConditions":"…"}, "media":[…] }
```
- ALERT: `alertType` (only `COVID_19`, historically) — do not support in Atlas; reported typically rejected/restricted. UNVERIFIED.
- Event time zone: schedule is interpreted in the location's local time (no tz field). UNVERIFIED.
- Summary max length **1500 characters** — UNVERIFIED (not found in index excerpts). Phone numbers in summary may be rejected by policy — UNVERIFIED.

## 6. Media rules

- Post media via `media[]` MediaItem with `mediaFormat` (`PHOTO | VIDEO`) and `sourceUrl`. [IDX]
- `sourceUrl` must be a **publicly accessible URL** (Google fetches it); alternatively `dataRef` from `media.startUpload` exists for the location media API. [IDX: upload-photos / media resource] For posts, use a public (or long-lived signed) HTTPS URL — Supabase signed URLs must stay valid until state leaves PROCESSING.
- Photo: **JPG or PNG, 10 KB – 5 MB, min 250×250 px, recommended 720×720**. [IDX: upload-photos]
- Video in posts via API: the mediaFormat enum permits VIDEO, but historically **local posts only reliably accept one PHOTO**; video post support via API is not documented as working (community reports). Treat as **UNVERIFIED/unsupported** — Atlas should post photo-only for GBP. Location-media video limits (≤30 s, ≤75 MB, ≥720p) UNVERIFIED.
- One media item per post in practice — UNVERIFIED.

## 7. State, polling, permalink

- `LocalPostState`: `LOCAL_POST_STATE_UNSPECIFIED | REJECTED | LIVE | PROCESSING` [IDX]. New posts typically return `PROCESSING` then become `LIVE` (or `REJECTED`, with no reason field). → **Polling is needed**: `GET …/localPosts/{id}` with backoff (e.g., 1 min, 5 min, 15 min, 1 h; stop at LIVE/REJECTED; ≤24 h).
- **No Pub/Sub notification for posts.** Notifications API types are only: `GOOGLE_UPDATE, NEW_REVIEW, UPDATED_REVIEW, NEW_CUSTOMER_MEDIA, NEW_QUESTION, UPDATED_QUESTION, NEW_ANSWER, UPDATED_ANSWER, DUPLICATE_LOCATION, VOICE_OF_MERCHANT_UPDATED` (`LOSS_OF_VOICE_OF_MERCHANT` deprecated). Config: `PATCH https://mybusinessnotifications.googleapis.com/v1/accounts/{id}/notificationSetting` with `pubsubTopic`; grant `mybusiness-api-pubsub@system.gserviceaccount.com` Publish. [DISC] Useful for VOM loss → disable publishing.
- `searchUrl` (output only): link to the post on Google Search — use as permalink. [IDX] May be absent while PROCESSING; fallback to `metadata.mapsUri`. UNVERIFIED on timing.

## 8. Idempotency after lost response

- No client request-id / idempotency key on localPosts.create (none seen in docs) — UNVERIFIED but consistent with schema.
- Recovery: before retrying a create whose response was lost, `GET …/localPosts?pageSize=…` (newest first — ordering UNVERIFIED) and match on exact `summary` + `topicType` + event title/schedule + `createTime` ≥ attempt time. Tip: embed nothing hidden; store attempt timestamp and normalized summary hash. If match → adopt its `name`; else retry. Use `DELETE` only for operator-confirmed duplicates.

## 9. Error classification (Google API standard error envelope `{error:{code,message,status,details[ErrorInfo]}}` — [DISC] from probe)

| HTTP / status | Class | Action |
|---|---|---|
| 400 INVALID_ARGUMENT (bad fields, missing event, url on CALL, media fetch failure) | permanent | show message, don't retry |
| 401 UNAUTHENTICATED | auth | refresh token once; if `invalid_grant` → reconnect |
| 403 PERMISSION_DENIED (API not enabled / not approved / no role on location / SERVICE_DISABLED) | config/permission | surface; don't retry |
| 404 NOT_FOUND (location/post removed or access lost) | permanent | re-pick location |
| 409 / FAILED_PRECONDITION (location unverified / no VOM / suspended) | permanent until fixed | check VoiceOfMerchantState |
| 429 RESOURCE_EXHAUSTED (QPM or 10-edits/min/profile) | transient | exponential backoff + jitter |
| 500/503/UNAVAILABLE/DEADLINE_EXCEEDED | transient | backoff; for create → idempotency check (§8) first |
Specific reason codes for GBP (e.g., quota `RATE_LIMIT_EXCEEDED`) — UNVERIFIED.

## 10. Quotas

- Default after approval: **300 QPM** per API (Business Information, Account Management, v4, Notifications, Verifications, Performance, Q&A, Place Actions, Lodging). [IDX: limits]
- **10 edits per minute per Business Profile — cannot be increased.** [IDX: limits] (Applies to writes such as post create/patch/delete — Atlas should serialize writes per location.)
- Quota increases via GBP API contact form; denied if usage <50% of limit or spiky. [IDX]
- Per-day caps / localPost count limits — UNVERIFIED.

## 11. Deprecations / status

- localPosts exist only on **v4** (`mybusiness.googleapis.com/v4`) and were never migrated to v1; v4 localPosts create/get/list/patch/delete remain supported, and the service answered live on 2026-09-26. [IDX + DISC probe]
- `localPosts.reportInsights` removed → Business Profile Performance API. [IDX: change log]
- Most other v4 endpoints (accounts, locations, admins, notifications) deprecated → Account Management / Business Information / Notifications v1. [IDX]
- `Location.metadata.canOperateLocalPost` deprecated/unpopulated. [DISC]
- `NotificationType.LOSS_OF_VOICE_OF_MERCHANT` deprecated → `VOICE_OF_MERCHANT_UPDATED`. [DISC]
- New: RecurrenceInfo for recurring posts (2025 change log). [IDX]

## Sources (all accessed 2026-09-26)

Direct (fetched):
- https://mybusinessaccountmanagement.googleapis.com/$discovery/rest?version=v1 (rev 20260923)
- https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1 (rev 20260923)
- https://mybusinessnotifications.googleapis.com/$discovery/rest?version=v1 (rev 20260923)
- https://mybusinessverifications.googleapis.com/$discovery/rest?version=v1 (rev 20260923)
- https://www.googleapis.com/discovery/v1/apis?preferred=false (no mybusiness v4 listed)
- Live probe: https://mybusiness.googleapis.com/v4/accounts/1/locations/1/localPosts (401, method LocalPosts.ListLocalPosts)

Official pages seen via search index only (direct fetch blocked):
- https://developers.google.com/my-business/content/overview
- https://developers.google.com/my-business/content/prereqs
- https://developers.google.com/my-business/content/basic-setup
- https://developers.google.com/my-business/content/implement-oauth
- https://developers.google.com/my-business/content/limits
- https://developers.google.com/my-business/content/faq
- https://developers.google.com/my-business/content/posts-data
- https://developers.google.com/my-business/content/upload-photos
- https://developers.google.com/my-business/content/change-log
- https://developers.google.com/my-business/content/latest-updates
- https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts (+ /create, /get, /list, /patch, /reportInsights)
- https://developers.google.com/my-business/reference/rpc/google.mybusiness.v4
- https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media

Tried and blocked: WebFetch developers.google.com (EGRESS_BLOCKED); curl developers.google.com, developers.google.cn, support.google.com, web.archive.org (proxy 403); v4 discovery `mybusiness.googleapis.com/$discovery/rest?version=v4|v4.9` (404); google-api-python-client 2.10/2.30 wheels (no mybusiness v4 doc).

## Re-verify before shipping (UNVERIFIED list)
summary 1500-char limit; OFFER requires event; ALERT restrictions; GET_OFFER deprecation; video-in-post support; one-media-per-post; list ordering; searchUrl timing; OAuth refresh-token expiry in Testing mode; GBP-specific error reason codes; SITE_MANAGER posting ability.
