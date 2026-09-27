# S94A Media Library: storage design

Atlas S94 (Marketing Publishing Platform), track S94A. Investigation and design only. No code, migration or deploy was made.

- Worktree: `/home/user/-V-OS-/.claude/worktrees/s94` at `5120a42` (merge of PR #92 `claude/determined-brahmagupta-6ea5j6`).
- Production (`dnefgcmjcgxlynycxkts`, org plan **pro**, Postgres 17, eu-west-1). Only read-only metadata queries were run: `storage.buckets`, object counts, `pg_policies` on `storage`, the marketing table list, and the plan via `get_organization`.
- Docs: `WebFetch` to supabase.com, developers.facebook.com and developers.tiktok.com is **blocked by the egress proxy**. I read the Supabase docs through the Supabase MCP `search_docs` tool, which returns the official page text. Those points are marked **[verified: URL]**. Provider (Meta/TikTok/Google) facts come only from WebSearch result summaries and are marked **[search-summary]** or **[unverified]**. Check them against the primary docs before implementation.

---

## 1. Inventory of existing storage patterns

### 1.1 Buckets in production (read 2026-09-26)

| Bucket | Public | file_size_limit | Allowed MIME | Objects | storage.objects policies | Write path |
|---|---|---|---|---|---|---|
| `atlas-media` | **true** | 10 MiB | jpeg, png, webp, heic, heif | 4 | 4 (select: active staff; insert/update/delete: manager/admin) | **Direct browser upload with RLS** (`recipes.js` `sb.storage.from('atlas-media').upload(...)`, then `getPublicUrl`). Client canvas resize to JPEG 0.86. No server sniffing. |
| `atlas-imports` | false | 50 MiB | csv, txt, json, pdf, xls/xlsx, images | 0 | 4 permissive (manager/admin, insert limited to `foldername[1] = auth.uid()`) + 2 **RESTRICTIVE** (`private.import_source_is_mutable` blocks update/delete of claimed sources) | **Direct browser upload with RLS** (`data-workspace.js`), read with `createSignedUrl(path, 120)` from the browser. |
| `atlas-profile-photos` | false | 2 MiB | webp, jpeg, png | 1 | **none** | **Edge gateway** `atlas-team-profile-photos`: multipart to the function, magic-byte sniff (PNG/JPEG/WebP), service-role `POST /storage/v1/object/...` with `x-upsert: false`, path `profiles/{profile_id}/{version_uuid}.{ext}`, metadata RPC `atlas_team_profile_photo_upsert`, compensating delete if the RPC fails, previous version deleted after swap. Signed read URL **6 h**. Client supplies width/height (bounded 64–2048, server stores). |
| `atlas-ai-media` | false | 25 MiB | images, pdf, txt, csv, audio | 5 | **none** (deliberate, see migration comment) | **Edge gateway** `atlas-ai` (`http.mjs` service-role upload, `handler.mjs` `contentMatches(mime, bytes)` covers JPEG/PNG/WebP/HEIF (ftyp brands)/PDF/UTF-8 text/WebM/Ogg/WAV/MP3/MP4-audio). Signed read URL **300 s**. Retention by `public.atlas_ai_media_purge_expired()`, with `media_retention_days` default 30 in settings. |
| `atlas-accounting-documents` | false | 15 MiB | images + pdf | 14 | **none** | **Edge gateway** `atlas-accounting` (S92, PR #92, now merged): `sniffType(bytes)` by content only, "never by name or declared type". Idempotent `request_id` replay removes the duplicate copy. Signed file link **300 s**, export links **900 s**, signed 8 at a time to stay inside the timeout. |

The global Storage file-size limit is a dashboard setting and cannot be read through SQL. **The current value is unknown and must be checked by the operator.**

### 1.2 Observations

1. Two patterns are in use:
   - **(A) direct-to-Storage with RLS policies**: `atlas-media`, `atlas-imports`. These are the older checkpoints, and later hardening (S87, phase A.2) had to tighten them.
   - **(B) private bucket with zero `storage.objects` policies, where only a service-role Edge gateway reads and writes**: profile photos, AI media, accounting. Every recent bucket uses (B). Marketing media should follow (B).
2. All (B) gateways buffer the whole file in the function (`await file.arrayBuffer()`). That works up to about 25 MiB. It cannot serve videos of hundreds of MB: the function memory cap is 256 MB, CPU is 2 s per request, and idle timeout is 150 s [verified: https://supabase.com/docs/guides/functions/limits]. That limits page documents **no explicit request-body limit** (unverified whether one exists). The design below keeps large bytes out of Edge Functions entirely.
3. No existing code uses `createSignedUploadUrl` or TUS. This would be a new pattern for Atlas, so its CORS and headers need rehearsal (§2.4).
4. Signed read URL lifetimes in the repo are 120 s (imports), 300 s (AI, accounting file), 900 s (accounting export) and 6 h (profile photos).
5. The existing marketing tables are in `atlas_private` (`marketing_content_items`, `marketing_campaigns`, revisions, approvals, recommendations, events). `marketing_content_items.media_requirements jsonb` and `frames jsonb` exist, but there is **no media table**. Atlas is single-venue: there is no `venues` table, and the `venue` Settings section holds identity and timezone.
6. `atlas-marketing-workspace` roles: WRITE = admin/manager/bartender. MANAGER (approve, mark published, manage connections) = admin/manager.

---

## 2. Marketing media storage design

### 2.1 Bucket

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('atlas-marketing-media','atlas-marketing-media', false,
        1073741824,   -- 1 GiB, see below
        array['image/jpeg','image/png','image/webp','image/heic','image/heif',
              'video/mp4','video/quicktime']::text[])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types, updated_at=now();
-- No storage.objects policy for this bucket, on purpose (pattern B).
```

- **Private.** Private-bucket downloads require either an RLS-authorised JWT or a signed URL [verified: https://supabase.com/docs/guides/storage/buckets/fundamentals]. There are no policies, so browsers cannot list, read or write objects. The service role bypasses RLS [verified: https://supabase.com/docs/guides/storage/security/access-control].
- **Size.**
  - Bucket limit: 1 GiB for masters. Per-kind limits are enforced by the gateway: images 30 MiB, videos 1 GiB.
  - Global limit: the bucket limit cannot exceed the global limit. Free plan caps the global limit at 50 MB; Pro allows up to 500 GB [verified: https://supabase.com/docs/guides/storage/uploads/file-limits]. The org is Pro, but the operator must raise the global limit in Storage Settings to at least 1 GiB. The current value is unverified.
  - Upload method: standard uploads handle up to 5 GB. Resumable/S3 uploads handle up to 50 GB and are recommended above 6 MB [verified: https://supabase.com/docs/guides/troubleshooting/upload-file-size-restrictions-Y4wQLT].
- **MIME types.**
  - SVG and GIF are excluded (script risk; no provider needs them).
  - HEIC/HEIF masters are allowed only when the client also produces a JPEG `publish` variant (§2.6), because Instagram image publishing expects JPEG [unverified, widely documented].
  - `video/quicktime` (iPhone `.mov`, H.264/HEVC) is allowed as a master. The publish worker must check provider codec support; HEVC `.mov` may be rejected by some providers [unverified].
  - `allowed_mime_types` is enforced against the *declared* content type. Content verification is ours (§2.5).

### 2.2 Path scheme

```
venues/{venue_key}/{yyyy}/{mm}/{asset_uuid}/original.{ext}
venues/{venue_key}/{yyyy}/{mm}/{asset_uuid}/v/{variant_uuid}.{ext}      -- thumbs, posters, crops, JPEG publish copies
```

- `venue_key` is a short slug, `main` today. It is a text slug, not a name, so a later multi-venue split needs no rename. Regex: `^[a-z0-9][a-z0-9-]{0,31}$`.
- `yyyy/mm` is the **server's UTC upload month**, fixed at `upload_init`. The object is never moved; objects are immutable, and upsert is always false. Browsing by month uses the DB, not the path.
- File names are server-generated. The user's filename is stored only as `original_filename` text, never in the path. That removes file-name restrictions and path-traversal concerns [file-name charset: verified: https://supabase.com/docs/guides/storage/uploads/file-limits].
- DB check constraint on `storage_path`: `'^venues/[a-z0-9-]{1,32}/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f-]{36}/(original|v/[0-9a-f-]{36})\.(jpg|png|webp|heic|heif|mp4|mov)$'`.
- New paths per version also avoid CDN staleness, which Supabase advises against overwriting for [verified: https://supabase.com/docs/guides/storage/uploads/resumable-uploads, "Overwriting files"].

### 2.3 Gateway: new Edge Function `atlas-marketing-media`

Pattern B, structured like `atlas-accounting/handler.mjs`: a `LIMITS` freeze, `sniffType`, service-role helper `{rpc, signUpload, info, rangeGet, sign, remove}`, CORS and `nosniff` headers, and `resolveActor` from `_shared/auth.mjs`.

| Action | Role | Purpose |
|---|---|---|
| `GET ?action=list&…` | active staff with marketing read | Library listing, with signed **thumbnail** URLs (300 s, 8 at a time) |
| `GET ?action=file&id=&variant=` | same | Signed URL for preview/download of a master or variant (300 s) |
| `POST ?action=upload_init` | WRITE (admin/manager/bartender) | Reserve asset row, return a signed upload token |
| `POST ?action=upload_complete` | uploader or manager | Verify object, store metadata, set `ready` |
| `POST ?action=variant_init` / `variant_complete` | WRITE | Same two-step flow for derived assets (poster/thumb/crop/publish JPEG) |
| `POST ?action=update` | WRITE | Title, alt text, tags, rights notes |
| `POST ?action=collection_*` | WRITE (create/reorder), MANAGER (delete) | Collections |
| `POST ?action=archive` / `restore` / `delete` | MANAGER | Soft delete with guard (§2.9) |

### 2.4 Upload mechanism: signed upload token, browser to Storage directly

Neither the browser nor an Edge Function streams large bytes through the gateway. The browser gets a **one-time path-bound signed upload token** that the gateway minted with the service role.

1. **`upload_init`** takes `{client_request_id, kind: image|video, declared_mime, byte_size, original_filename, client_hints:{width,height,duration_ms}}`.
   - Checks: role; `declared_mime` in the kind's allowlist; `byte_size` ≤ kind limit; per-user pending quota (for example ≤ 10 pending, ≤ 5 GiB pending).
   - Inserts `marketing_media_assets` with status `pending_upload`, server `storage_path` and `upload_expires_at = now()+2h`. The call is idempotent on `client_request_id`.
   - Calls `POST {SUPABASE_URL}/storage/v1/object/upload/sign/atlas-marketing-media/{path}` (the service-role equivalent of `createSignedUploadUrl(path)`, without upsert) and returns `{asset_id, path, token, expires_at}`.
   - Signed upload URLs "can be used to upload files to the bucket without further authentication. They are valid for 2 hours" [verified: https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl]. The 2 h lifetime is fixed by the platform. Atlas also enforces its own `upload_expires_at`.
   - The exact REST route for signing uploads is inferred from the SDK and is **[unverified]**. Confirm it against `@supabase/storage-js` source or use the SDK via `jsr:@supabase/supabase-js`.
2. **Browser upload.**
   - **Images ≤ 6 MiB:** `sb.storage.from('atlas-marketing-media').uploadToSignedUrl(path, token, file, {contentType})`. This is a single PUT.
   - **Videos and anything > 6 MiB:** TUS resumable (`tus-js-client`, loaded from cdnjs/jsdelivr per the app's CSP rules):
     - Endpoint: `https://dnefgcmjcgxlynycxkts.storage.supabase.co/storage/v1/upload/resumable/sign` (the **signed** TUS route; the plain `/upload/resumable` runs as the caller's role and RLS refuses it on a bucket with no policy — verified against the Storage API, `scripts/e2e/s94-media`). The direct storage hostname is recommended for large files.
     - Chunk size must be 6 MB.
     - Send the token in the **`x-signature` header**: "Resumable uploads also supports using signed upload tokens … including the returned token in the `x-signature` header".
     - The TUS upload URL is valid for up to 24 h.
     - Use `removeFingerprintOnSuccess: true` and **no `x-upsert`**. Concurrent uploads to the same path give `409` to the loser.
     - Source for all TUS points: [verified: https://supabase.com/docs/guides/storage/uploads/resumable-uploads].
     - Companion headers **[verified locally against supabase/storage-api v1.11.13]**: `tus-resumable`, `x-signature` (the token), and `apikey` with the publishable key; no user JWT is needed on `/upload/resumable/sign` (the token is checked on every POST, HEAD and PATCH).
   - Progress UI comes from TUS `onProgress`. Resume after tab reload uses `findPreviousUploads()`, within the 2 h token and 24 h TUS URL windows.
3. **Why not the alternatives.**
   - Direct upload with RLS (pattern A) would need a broad INSERT policy on the bucket, and any authenticated session could write arbitrary paths and sizes until verification.
   - Streaming through the Edge gateway runs into the 256 MB memory, 2 s CPU and 150 s idle limits, plus a doubled transfer.
   - The token is bound to a single server-chosen path. Without upsert it cannot overwrite an object once one exists. This does not guard against a leaked token being used by someone else first; verification (§2.5) and the per-user pending row cover that case.

### 2.5 Server-side verification (`upload_complete`)

The gateway does **all** of the following. Nothing from the client is trusted except as a bounded hint.

1. **Existence and size.** Read the object record by service-role RPC: `select metadata->>'size', metadata->>'mimetype', created_at from storage.objects where bucket_id=… and name=…`. A security-definer RPC in `atlas_private` is preferred over the Storage `info` endpoint because it is transactional with the row update. `size` must equal the declared `byte_size` (±0) and be within the kind limit. Otherwise the result is `rejected`.
2. **Magic bytes by ranged read.** `GET /storage/v1/object/authenticated/atlas-marketing-media/{path}` with `Range: bytes=0-65535` (service role).
   - Reuse `contentMatches`/`ftypBrands` from `atlas-ai/handler.mjs` (move them to `_shared/media-sniff.mjs`) and extend them with video:
     - `video/mp4`: ISO-BMFF `ftyp` with major/compatible brand in {`isom`,`iso2`,`iso4`,`iso5`,`iso6`,`mp41`,`mp42`,`avc1`,`dash`,`M4V `} and **no** HEIF image brand.
     - `video/quicktime`: `ftyp` major brand `qt  `, or a leading `moov`/`mdat`/`wide`/`free` atom (legacy MOV).
   - The sniffed type wins. A declared/sniffed mismatch within the same kind is corrected (for example a `.mov` that is really MP4); a cross-kind mismatch is rejected.
   - **Range support on the authenticated object route is [unverified]** because no Supabase doc page confirming it was found. Fallback: mint a 60 s signed URL and range-GET it, or read the stream and `reader.cancel()` after 64 KiB. Both avoid loading the whole file.
3. **Server-side dimensions.** These are cheap parses of the first 64 KiB:
   - Images: JPEG SOFn, PNG IHDR, WebP VP8/VP8L/VP8X, and HEIF `ispe` when inside the window.
   - Video: parse `moov → mvhd` (timescale, duration) and `trak → tkhd` (width/height, rotation matrix). If `moov` is at the end (common for camera files), issue a second range for the last 2 MiB. If it still cannot be parsed, store client hints with `metadata_source='client'` and mark the asset `needs_review=false` but `server_probe='partial'`.
   - Bounds: images 200–12000 px per side and ≤ 80 MP; video duration 1 s–15 min (provider-specific checks happen at attach time, §3.4).
4. **Hash (optional).** SHA-256 of a 1 GiB file does not fit the 2 s CPU budget. Store the client-computed SHA-256 (`crypto.subtle` in a Worker) as `client_sha256` for **dedupe hints only**. For images ≤ 30 MiB the gateway can compute `sha256` server-side in a separate call if needed.
5. **Outcome.**
   - Success: status `ready` and `verified_at`.
   - Failure: status `rejected` with `reject_reason`, and the object is deleted with the service role, as profile-photos does with compensating deletes.
   - `upload_complete` is idempotent. If it is never called, the janitor handles it.
6. **Janitor.** Extend a purge RPC, following `atlas_ai_media_purge_expired`, so the worker or a cron call can:
   - Mark `pending_upload` rows past `upload_expires_at + 22h` (covering the TUS 24 h window) as `abandoned` and delete their objects.
   - Delete **orphan objects**: `storage.objects` in this bucket older than 24 h with no asset or variant row.

   Deletion goes through the Storage API (`DELETE /storage/v1/object/{bucket}`), never `delete from storage.objects`.

### 2.6 Metadata extraction, thumbnails, posters, variants

- **Client-side extraction** (hints): `createImageBitmap(file)` / `<img>.naturalWidth/Height`, and `<video preload="metadata">` → `videoWidth`, `videoHeight`, `duration`. The browser already does this for profile photos (`team-profile-photos.js`) and recipes (`recipes.js`).
- **Poster frame (video).** The client seeks `<video>` to a frame (default 1.0 s, user-choosable), draws to canvas, and exports JPEG at quality 0.85, long edge ≤ 1080. It is uploaded as a **variant** with `purpose='poster'`. This is small, so it may use `uploadToSignedUrl` via `variant_init`, or go multipart through the gateway (≤ 2 MiB, like profile photos). The server sniffs the result as JPEG and parses its dimensions.
- **Thumbnails.** Client JPEG/WebP, long edge 480, `purpose='thumb'`, for images and from the poster for videos. The library grid always uses thumbs, never masters.
  - Alternative: Supabase Image Transformations via `createSignedUrl(path, s, {transform})` are Pro+ with a quota of 100 origin images/cycle then $5 per 1,000, 25 MB source max, 50 MP max, width/height 1–2500, and HEIC is source-only [verified: https://supabase.com/docs/guides/storage/serving/image-transformations].
  - Not recommended as the primary path: cost, 25 MB cap, and no video support. It could be an optional fallback for missing image thumbs.
- **Publish JPEG.** For HEIC/HEIF/PNG/WebP masters, the client produces `purpose='publish'` JPEG (long edge ≤ 1440 or 2048, quality 0.9, sRGB) for Instagram, Google and TikTok photo use. If the browser cannot decode HEIC (non-Safari), `upload_init` for a HEIC master is refused with "Convert to JPEG first", or the file is converted in Safari.
- **Crops.** Client canvas crops of image masters at 1:1, 4:5, 9:16 and 1.91:1. They are stored as `purpose='crop'` variants with `aspect_ratio` and `crop_rect` (normalised 0–1 relative to the master).
  - Video crops are **not produced** in v1: Edge has no ffmpeg, and libvips/sharp are unsupported [verified: functions/limits "Node Libraries that require multithreading are not supported … libvips, sharp"]. Store the crop *intent* only and warn when the video aspect does not fit the target placement.
- **Masters are immutable.** Variants reference `asset_id`, never replace the master, and are deleted only with the asset's hard purge. Re-cropping creates a new variant row and path, and the old one is kept while attached.

### 2.7 Collections, order, tags

- Collections are named, ordered albums, optionally linked to a campaign.
- Items have `position` (gap-free integer, reordered in one RPC with a deferrable unique constraint).
- An asset may be in many collections.
- Tags are a normalized `slug`/`label` vocabulary with an asset↔tag join. The `tags text[]` shortcut is avoided so that renames and counts stay consistent.

### 2.8 Usage tracking

- `marketing_content_media` records **planned** use (attachments).
- `marketing_media_publication_uses` records **actual** use. The publish worker writes one row per asset/variant per provider publication attempt, with provider media id, fetch method, signed-URL expiry (not the URL) and outcome.
- The library shows "Used in N posts / last published".

### 2.9 Deletion and retention

- **Archive** (`archived_at`): hidden from the library picker, still resolvable for existing content. Reversible.
- **Delete** (soft): status `deleted` and `deleted_at`, `purge_after = deleted_at + 30 days` (setting `marketing.media_trash_days`, 1–365, like `media_retention_days`). Restorable until the purge. The RPC **refuses** delete when:
  - the asset or any of its variants is attached (`marketing_content_media`) to content whose status is in (`approved`,`scheduled`,`published`,`completed`), or to content that has an active publication job (`queued`/`publishing`, owned by the S94 publishing track); or
  - it has any `marketing_media_publication_uses` row with outcome `published`. Published history is kept for audit. Only **archive** is allowed; the hard purge is blocked until an explicit manager "remove published history media" action, which is out of scope for v1.
- Attaching a non-`ready`, archived or deleted asset is refused. A content transition to `scheduled` re-checks that every attachment is `ready`.
- **Purge:** `marketing_media_purge_due(p_limit)` deletes objects (master and variants) through the Storage API, then rows. It is batched and idempotent, following `atlas_ai_media_purge_expired`.
- A DB trigger `before delete on marketing_media_assets` raises unless `status='deleted' and purge_after <= now()` and there are no blocking references. This is defence in depth against service-role mistakes.

---

## 3. How providers fetch media

All provider facts below are **[search-summary]** or **[unverified]**, because primary docs were not reachable. Confirm them before implementation.

### 3.1 Provider matrix

| Provider | Mechanism | Needs public URL? | Atlas approach |
|---|---|---|---|
| **Instagram Graph** (images, carousel items) | `POST /{ig-user-id}/media` with `image_url`. Meta cURLs it; must be publicly accessible at attempt time; JPEG. | Yes | Worker mints a **signed URL of the `publish` JPEG variant**, expiry 15 min, then creates the container, polls `status_code`, publishes. |
| **Instagram Reels/Video** | `video_url` (public URL) **or** `upload_type=resumable`, then POST bytes to `rupload.facebook.com/ig-api-upload/{ver}/{container}` with `offset`/`file_size` headers (alternatively a `file_url` header) [search-summary] | No (resumable) | Prefer **resumable byte push** from the worker (no URL leaves Atlas). Fallback: `video_url` with a signed URL, expiry 60 min, covering Meta's async processing window [unverified sizing]. |
| **Facebook Page** | Photos: `url` or multipart `source`. Videos: `file_url` or resumable upload sessions [unverified] | No | Photos: multipart **upload from the worker** for ≤ 10 MB, otherwise signed URL (15 min). Videos: resumable upload from the worker. |
| **TikTok video** | `FILE_UPLOAD`: `init` returns `upload_url`; PUT chunks of 5–64 MB (final ≤ 128 MB); files < 5 MB go whole; `total_chunk_count = floor(size/chunk)`. `PULL_FROM_URL` requires a **verified domain or URL prefix**, https, **no redirects**, and TikTok's download times out 1 h after init [search-summary] | No (FILE_UPLOAD) | **FILE_UPLOAD from the worker**, streaming ranged reads from Storage (§3.3). |
| **TikTok photo** | `/v2/post/publish/content/init/` with `photo_images` URLs, **PULL_FROM_URL only**, verified domain/prefix [search-summary] | Yes, verified | **Blocked** until Atlas owns a verified https prefix. `*.supabase.co` cannot be domain-verified by us. Options: (a) Supabase custom domain add-on, then verify it; (b) an Atlas-domain proxy path (for example a Netlify `/m/*` **200 rewrite**, not a redirect, to a worker endpoint that validates a one-time token and streams the object); (c) exclude TikTok photo posts in v1. **Decision needed.** |
| **Google Business Profile local posts** | `media[{mediaFormat:"PHOTO", sourceUrl}]`; local posts support URL-based media only [search-summary] | Yes | Signed URL of the `publish` JPEG. Expiry 60 min, because whether Google fetches synchronously is unverified. Record the fetch result via the post's media state. |

### 3.2 Controlled signed-URL issuance

- Only the **publish worker** (service role, server-side) signs provider URLs, **at publish time**, for exactly the attached asset or variant, via `POST /storage/v1/object/sign/atlas-marketing-media/{path}` with `{expiresIn}`. This is the same helper as profile-photos, AI and accounting.
- The expiry is set per provider/kind in one table:

  ```js
  const PROVIDER_URL_TTL = { instagram_image: 900, instagram_video_url: 3600, facebook_photo_url: 900, gbp_photo: 3600, tiktok_pull: 3600 };
  ```

  Nothing is minted for FILE_UPLOAD or resumable pushes.
- **Never log or persist signed URLs.** Store only `url_expires_at`, `fetch_method` and the path hash in `marketing_media_publication_uses`. Signed URLs are bearer secrets.
- **Never sign masters that are HEIC or `.mov` for image targets.** The resolver picks, in order: explicit attachment variant → `publish` variant → master if its MIME is acceptable to the target → error `media_not_publishable`.
- The browser never receives provider-facing URLs. Browser previews use separate 300 s URLs.

### 3.3 TikTok FILE_UPLOAD within Edge limits

Limits: 256 MB memory, 2 s CPU (async I/O excluded), wall clock 150 s on Free / **400 s on paid** [verified: functions/limits].

- `chunk_size` is 16–32 MB (within TikTok's 5–64 MB range). For each chunk, `fetch` Storage with `Range: bytes=a-b` (service role) and `PUT` the `ReadableStream` straight to `upload_url` with `Content-Range: bytes a-b/total`. Memory holds at most one chunk.
- Persist `{publish_job_id, upload_url_host, next_offset, chunk_size, total_chunks, init_at}` after every chunk. Re-enqueue the job if the elapsed time exceeds about 300 s, so a 1 GiB video spans several invocations. The `upload_url` lifetime (reported as 1 h) is [unverified]; a restart must re-`init`.
- The same resumable pattern applies to Instagram and Facebook resumable pushes.
- Range reads from Storage need rehearsal (see §2.5 [unverified]).

### 3.4 Pre-publish validation

At attach time and again at schedule time, check per placement:
- MIME, dimensions and aspect range
- Duration range
- Size limit
- Carousel counts

Provider numbers live in a versioned `PROVIDER_MEDIA_RULES` table in code, owned by the publishing track. The values are **[unverified]** until checked against primary docs.

### 3.5 SSRF and related risks

- **Outbound fetches by Atlas.**
  - The worker only ever fetches our own Storage (`{SUPABASE_URL}/storage/v1/...`), built from a DB `storage_path` that passed the path regex. There is **no "import from URL"** in v1.
  - If one is added later, it must use an allowlisted scheme (https), resolve DNS and refuse private, loopback and link-local ranges (including `169.254.169.254`), re-validate after each redirect (or set `redirect:"manual"`), and apply byte, time and MIME caps with sniffing.
- **Provider-returned URLs** (TikTok `upload_url`, Meta `rupload`/`uri`): validate the host against an allowlist before sending bytes or tokens, for example `*.tiktokapis.com`, `open-upload*.tiktokapis.com`, `rupload.facebook.com`, `graph.facebook.com`, `graph-video.facebook.com`, `mybusiness.googleapis.com` [unverified exact hosts]. This prevents a tampered or mis-parsed response from redirecting our bytes or tokens elsewhere.
- **Inbound fetches by providers:** signed URLs are short-lived, per-object and read-only. The bucket stays private. No public bucket or permanent URL is ever created. A leaked URL exposes one file until expiry.
- **Upload abuse:** server-chosen path, fixed token lifetime, per-user pending quota, sniffing, size equality, and a janitor for abandoned and orphan objects.
- **Content served to browsers:** only via signed URLs on `*.supabase.co`, not the app origin. SVG and HTML are not allowed MIME types.

---

## 4. Proposed schema (`atlas_private`, service_role only, like existing marketing tables)

The requested conceptual names are kept: `marketing_media_assets`, `marketing_media_collections`, `marketing_media_collection_items`, `marketing_content_media`. Supporting tables are added for variants, tags and publication uses.

```sql
-- 4.1 Assets (masters)
create table atlas_private.marketing_media_assets (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  venue_key text not null default 'main' check (venue_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  kind text not null check (kind in ('image','video')),
  status text not null default 'pending_upload'
    check (status in ('pending_upload','verifying','ready','rejected','abandoned','deleted')),
  bucket_id text not null default 'atlas-marketing-media' check (bucket_id = 'atlas-marketing-media'),
  storage_path text not null unique
    check (storage_path ~ '^venues/[a-z0-9-]{1,32}/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f-]{36}/original\.(jpg|png|webp|heic|heif|mp4|mov)$'),
  original_filename text check (char_length(original_filename) <= 255),
  declared_mime text not null,
  mime_type text,                        -- sniffed; null until verified
  declared_bytes bigint not null check (declared_bytes between 1 and 1073741824),
  byte_size bigint check (byte_size between 1 and 1073741824),
  client_sha256 text check (client_sha256 ~ '^[0-9a-f]{64}$'),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width between 1 and 16384),
  height integer check (height between 1 and 16384),
  duration_ms integer check (duration_ms between 0 and 3600000),
  rotation smallint check (rotation in (0,90,180,270)),
  frame_rate numeric(6,3),
  has_audio boolean,
  metadata_source text check (metadata_source in ('server','client','mixed')),
  server_probe text check (server_probe in ('full','partial','none')),
  title text check (char_length(title) <= 180),
  alt_text text check (char_length(alt_text) <= 1000),
  notes text check (char_length(notes) <= 4000),
  source text not null default 'upload' check (source in ('upload','ai_generated','import')),
  rights_status text not null default 'owned'
    check (rights_status in ('owned','licensed','user_generated_permission','unknown')),
  people_consent boolean,                -- faces of staff/guests: consent recorded
  upload_expires_at timestamptz,
  verified_at timestamptz,
  reject_reason text,
  archived_at timestamptz,
  deleted_at timestamptz,
  purge_after timestamptz,
  uploaded_by uuid not null, uploaded_by_label text, uploaded_by_role text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'video' or duration_ms is null),
  check (status <> 'ready' or (mime_type is not null and byte_size is not null and verified_at is not null)),
  check (status <> 'deleted' or (deleted_at is not null and purge_after is not null)),
  check ((kind='image' and coalesce(mime_type,declared_mime) in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
      or (kind='video' and coalesce(mime_type,declared_mime) in ('video/mp4','video/quicktime')))
);
create index marketing_media_assets_library_idx on atlas_private.marketing_media_assets (venue_key, created_at desc)
  where status = 'ready' and archived_at is null;
create index marketing_media_assets_pending_idx on atlas_private.marketing_media_assets (upload_expires_at)
  where status in ('pending_upload','verifying');
create index marketing_media_assets_purge_idx on atlas_private.marketing_media_assets (purge_after) where status = 'deleted';
create index marketing_media_assets_uploader_idx on atlas_private.marketing_media_assets (uploaded_by, created_at desc);
create index marketing_media_assets_sha_idx on atlas_private.marketing_media_assets (coalesce(sha256, client_sha256))
  where coalesce(sha256, client_sha256) is not null;

-- 4.2 Derived variants (never replace master)
create table atlas_private.marketing_media_variants (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete restrict,
  purpose text not null check (purpose in ('thumb','poster','crop','publish')),
  aspect_ratio text check (aspect_ratio in ('1:1','4:5','9:16','16:9','1.91:1','original')),
  crop_rect jsonb check (crop_rect is null or (jsonb_typeof(crop_rect)='object'
      and crop_rect ?& array['x','y','w','h'])),
  source_time_ms integer check (source_time_ms >= 0),          -- poster frame time
  status text not null default 'pending_upload' check (status in ('pending_upload','ready','rejected','deleted')),
  storage_path text not null unique
    check (storage_path ~ '^venues/[a-z0-9-]{1,32}/[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f-]{36}/v/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type text check (mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer check (byte_size between 1 and 31457280),
  width integer check (width between 1 and 8192),
  height integer check (height between 1 and 8192),
  created_by uuid not null, created_by_label text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (purpose <> 'crop' or (aspect_ratio is not null and crop_rect is not null)),
  check (purpose <> 'poster' or source_time_ms is not null)
);
-- one live thumb/poster per asset; many crops/publish copies allowed (history)
create unique index marketing_media_variants_one_thumb on atlas_private.marketing_media_variants (asset_id, purpose)
  where purpose in ('thumb','poster') and status = 'ready' and deleted_at is null;
create index marketing_media_variants_asset_idx on atlas_private.marketing_media_variants (asset_id);

-- 4.3 Collections
create table atlas_private.marketing_media_collections (
  id uuid primary key default gen_random_uuid(),
  venue_key text not null default 'main',
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 2000),
  campaign_id uuid references atlas_private.marketing_campaigns(id) on delete set null,
  cover_asset_id uuid references atlas_private.marketing_media_assets(id) on delete set null,
  archived_at timestamptz,
  created_by uuid not null, created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index marketing_media_collections_name_uq on atlas_private.marketing_media_collections (venue_key, lower(name))
  where archived_at is null;
create index marketing_media_collections_campaign_idx on atlas_private.marketing_media_collections (campaign_id);
create index marketing_media_collections_cover_idx on atlas_private.marketing_media_collections (cover_asset_id);

-- 4.4 Ordered collection items
create table atlas_private.marketing_media_collection_items (
  collection_id uuid not null references atlas_private.marketing_media_collections(id) on delete cascade,
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete cascade,
  position integer not null check (position >= 0),
  added_by uuid not null,
  added_at timestamptz not null default now(),
  primary key (collection_id, asset_id),
  constraint marketing_media_collection_items_position_uq unique (collection_id, position) deferrable initially deferred
);
create index marketing_media_collection_items_asset_idx on atlas_private.marketing_media_collection_items (asset_id);

-- 4.5 Tags
create table atlas_private.marketing_media_tags (
  id uuid primary key default gen_random_uuid(),
  venue_key text not null default 'main',
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  label text not null check (char_length(label) between 1 and 48),
  created_at timestamptz not null default now(),
  unique (venue_key, slug)
);
create table atlas_private.marketing_media_asset_tags (
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete cascade,
  tag_id uuid not null references atlas_private.marketing_media_tags(id) on delete cascade,
  tagged_by uuid, tagged_at timestamptz not null default now(),
  primary key (asset_id, tag_id)
);
create index marketing_media_asset_tags_tag_idx on atlas_private.marketing_media_asset_tags (tag_id);

-- 4.6 Content ↔ media attachments (planned use)
create table atlas_private.marketing_content_media (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete cascade,
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete restrict,
  variant_id uuid references atlas_private.marketing_media_variants(id) on delete restrict,
  platform text check (platform in ('instagram','facebook','tiktok','google-business-profile')), -- null = all platforms
  position smallint not null check (position between 0 and 34),
  role text not null default 'item' check (role in ('primary','cover','item','thumbnail')),
  alt_text text check (char_length(alt_text) <= 1000),
  added_by uuid not null, added_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_content_media_pos_uq unique nulls not distinct (content_id, platform, position)
    deferrable initially deferred,                      -- PG15+: NULL platform treated as a value
  constraint marketing_content_media_asset_uq unique nulls not distinct (content_id, platform, asset_id, variant_id)
);
create unique index marketing_content_media_one_primary on atlas_private.marketing_content_media
  (content_id, coalesce(platform,'*')) where role = 'primary';
create unique index marketing_content_media_one_cover on atlas_private.marketing_content_media
  (content_id, coalesce(platform,'*')) where role = 'cover';
create index marketing_content_media_asset_idx on atlas_private.marketing_content_media (asset_id);
create index marketing_content_media_variant_idx on atlas_private.marketing_content_media (variant_id);
-- trigger: variant_id (if set) must belong to asset_id; asset must be status 'ready' and not archived at insert.

-- 4.7 Actual provider use (written by publish worker only)
create table atlas_private.marketing_media_publication_uses (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references atlas_private.marketing_media_assets(id) on delete restrict,
  variant_id uuid references atlas_private.marketing_media_variants(id) on delete restrict,
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete restrict,
  publication_job_id uuid,               -- FK to the S94 publishing-jobs table (other track)
  platform text not null check (platform in ('instagram','facebook','tiktok','google-business-profile')),
  fetch_method text not null check (fetch_method in ('signed_url','file_upload','resumable_push','multipart')),
  url_expires_at timestamptz,            -- never the URL itself
  provider_media_id text,
  outcome text not null check (outcome in ('attempted','processing','published','failed')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index marketing_media_publication_uses_asset_idx on atlas_private.marketing_media_publication_uses (asset_id, created_at desc);
create index marketing_media_publication_uses_content_idx on atlas_private.marketing_media_publication_uses (content_id);
create index marketing_media_publication_uses_variant_idx on atlas_private.marketing_media_publication_uses (variant_id);
```

Grants and RLS follow `team_profile_photos`: `enable row level security`, a single `for all to service_role` policy, and `revoke all … from public, anon, authenticated`. All access goes through `atlas-marketing-media` → `public.atlas_marketing_media_*` security-definer RPC wrappers (the `marketing_*` wrapper pattern of checkpoint D). Add `updated_at` triggers as in existing marketing tables, and FK indexes as in `20260803150824_atlas_marketing_foreign_key_indexes.sql`.

Compatibility with existing content:
- `marketing_content_items.media_requirements` stays the brief ("need 1 vertical video").
- `marketing_content_media` is the fulfilment.
- `frames jsonb` (story frames) can reference `marketing_content_media.id` by position.

Key RPCs (security definer, `set search_path=''`):
- `marketing_media_reserve_upload`, `marketing_media_complete_upload`
- `marketing_media_reserve_variant`, `marketing_media_complete_variant`
- `marketing_media_list`, `marketing_media_update`
- `marketing_media_collection_upsert`, `marketing_media_collection_reorder(p_collection_id, p_asset_ids uuid[])`
- `marketing_media_tag_set`
- `marketing_content_media_set(p_content_id, p_items jsonb)` (replace-all, deferred constraints)
- `marketing_media_archive`, `marketing_media_restore`, `marketing_media_soft_delete` (with the §2.9 guard)
- `marketing_media_purge_due(p_limit)`, `marketing_media_janitor_candidates(p_limit)`
- `marketing_media_resolve_for_publish(p_content_id, p_platform)` (worker-only; returns paths, MIME and dimensions, never URLs)

---

## 5. Operator actions and rehearsal checklist

1. Check the **global Storage file size limit** in the dashboard and raise it to ≥ 1 GiB (Pro allows up to 500 GB). Without that, the bucket limit and large uploads fail.
2. On a Supabase branch, rehearse:
   - (a) the service-role sign-upload REST route;
   - (b) `uploadToSignedUrl` and TUS with `x-signature`: required headers and CORS from the Netlify origin;
   - (c) whether bucket `allowed_mime_types` and `file_size_limit` are enforced for TUS and signed uploads (expected yes, unverified);
   - (d) `Range` reads on `/object/authenticated/…` and on signed URLs;
   - (e) the moov-at-end probe on iPhone `.mov` and Android `.mp4`.
3. Decide on TikTok photo posts: custom domain or proxy for PULL_FROM_URL, or defer.
4. Verify all provider limits and URL rules against primary Meta, TikTok and Google docs. Network egress to them was blocked for this investigation.
5. Add `marketing.media_trash_days` to the Settings `marketing` section.
6. Refactor `contentMatches`/`ftypBrands`/`sniffType` into `_shared/media-sniff.mjs`, used by atlas-ai, accounting and marketing-media, with tests under `tests/`.

## 6. Sources

Supabase docs, retrieved via the Supabase MCP `search_docs`; direct fetch was blocked:
- https://supabase.com/docs/guides/functions/limits (256 MB memory, 150 s/400 s wall clock, 2 s CPU, 150 s idle timeout, no libvips/sharp)
- https://supabase.com/docs/guides/storage/uploads/file-limits (global limit: Free 50 MB, Pro 500 GB; bucket ≤ global; file-name charset)
- https://supabase.com/docs/guides/troubleshooting/upload-file-size-restrictions-Y4wQLT (standard ≤ 5 GB; resumable/S3 ≤ 50 GB; > 6 MB prefer resumable)
- https://supabase.com/docs/guides/storage/uploads/resumable-uploads (TUS endpoint, direct storage hostname, 6 MB chunks, 24 h upload URL, 409 concurrency, `x-signature` presigned TUS, avoid overwrites)
- https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl (signed upload URL valid 2 h, no further auth)
- https://supabase.com/docs/guides/storage/security/access-control (no uploads without policies; service key bypasses RLS)
- https://supabase.com/docs/guides/storage/buckets/fundamentals (private-bucket download only via JWT+RLS or signed URL)
- https://supabase.com/docs/guides/storage/serving/image-transformations (Pro+, quota and pricing, 25 MB / 50 MP / 2500 px limits, HEIC source only)

Provider pages, known only from WebSearch summaries (not fetched):
- https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
- https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads/
- https://developers.google.com/my-business/content/posts-data
- https://developers.google.com/my-business/content/upload-photos
