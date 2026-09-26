# S94 Media end to end on real Supabase Storage (local only)

Proves the Marketing › Media upload flow against the real Storage API, not a
mock: the real `atlas-marketing-media` handler, PostgREST, a replayed Atlas
database, and the real `apps/web` in Chromium. Nothing here reaches a hosted
project: every URL is loopback, the browser runs without a proxy and only two
fake hosts are mapped to the local proxy.

## Requirements

- Docker (host networking), images `supabase/storage-api:v1.11.13` and
  `postgrest/postgrest:v12.2.3`
- PostgreSQL 16 on 127.0.0.1:5432 (`postgres`/`postgres`), `psql`, `openssl`
- Node 20+ with Playwright and its Chromium (browser suite only), and
  `ATLAS_BROWSER_LIBS` pointing at a `node_modules` with
  `@supabase/supabase-js@2.45.4` and `lucide@0.454.0` (as for `tests/browser`)
- Python 3 with `pillow pillow-heif imageio-ffmpeg` (sample media)

## One command

```sh
ATLAS_BROWSER_LIBS=/path/to/node_modules scripts/e2e/s94-media/run.sh all   # or: gateway | browser
```

Each suite gets a fresh database and stack; containers are stopped at the end.
Output: `$E2E_WORK` (default `/tmp/s94-media-e2e`): `gateway.out`,
`browser.out`, `browser-after.out`, `stack.log` (proxy access log: method,
host, path, status), `functions.log` (the handlers' console output),
`shots/` (desktop, phone, unreachable).

## Step by step

```sh
source scripts/e2e/s94-media/env.sh
python3 scripts/e2e/s94-media/make_samples.py "$E2E_WORK/samples"
scripts/e2e/s94-media/setup.sh               # database + Storage + PostgREST
node scripts/e2e/s94-media/stack.mjs &       # proxy, auth stub, handlers, app
node scripts/e2e/s94-media/gateway-e2e.mjs   # [--only=library,delete,failures,expiry,boundary,orphans,logs,<file>]
node scripts/e2e/s94-media/browser-e2e.mjs   # needs a fresh setup.sh for exact counts
scripts/e2e/s94-media/teardown.sh            # KEEP_DB=1 keeps the database
```

## Order of the database build (why)

`scripts/verify_full_migration_replay.sh` bootstraps a minimal stand-in
`storage` schema, while the Storage API owns that schema and migrates it
itself. So `setup.sh`:

1. creates `$E2E_DB` and runs the replay bootstrap only (`ATLAS_BOOTSTRAP_ONLY=1`:
   roles, schemas, `auth.users`),
2. drops the stand-in `storage` schema,
3. starts the Storage API (`DB_INSTALL_ROLES=false`), which runs its 26
   storage migrations,
4. runs the full replay on top (its bootstrap is idempotent against the real
   tables; the S94A migration inserts the private `atlas-marketing-media`
   bucket into the real `storage.buckets`),
5. harness only: `auth.uid()/role()/email()` also read `request.jwt.claims`
   (as the hosted auth schema does; PostgREST 12 sets only that), and seeds an
   admin, a manager and a bartender (`seed.sql`, password `s94-e2e-password`),
6. starts PostgREST.

## The stack (`stack.mjs`)

- One base URL `https://<ref>.supabase.co` (fake ref `s94e2elocalmediatest`):
  `/rest/v1` → PostgREST, `/storage/v1` → Storage API, `/auth/v1` → a password
  auth stub (HS256 JWTs with the shared secret), `/functions/v1/atlas-marketing-media`
  and `/functions/v1/atlas-marketing-workspace` → the real handlers
  (`createMarketingMediaHandler`, `createMarketingHandler`) in Node. Any other
  function answers 404 without CORS headers, like an undeployed function.
- `https://<ref>.storage.supabase.co` is the same proxy (the handler hands
  browsers the direct storage host for TUS, as in production).
- Chromium maps both hosts to the proxy (`--host-resolver-rules`, self-signed
  certificate, no proxy server), so preflights and CORS are real.
- The app is served from `http://localhost:54380` with `config.js` pointed at
  the fake ref and `MODE: "local-e2e"` (the production boundary pins the
  production ref and an `sb_publishable_` key).
- Controls: `POST /__e2e/function-off?name=` / `function-on`,
  `/__e2e/fail-next-put`, `/__e2e/fail-puts?ms=` (cut Storage PUTs mid-body).

## What is covered

Gateway (`gateway-e2e.mjs`, 109 checks): JPG, PNG, WebP, HEIC (with a JPEG
publish copy, the preview then serves that copy), a 1 MiB MP4 by single PUT and
a 13 MiB MP4 by TUS (moov after mdat); signed upload URL shape, one-time token
(a second PUT is refused), stored object size and MIME, `pending_upload` →
`ready` with server-verified MIME/size/dimensions/sha256/duration/audio, variant
rows, 300-second preview links that work and then expire, Range on video,
no storage path or `*_path` key in any response; list, search, Photos/Videos,
collections, Used/Unused; delete refused for scheduled and published media;
soft delete and the administrator purge (objects, then rows); SVG named `.jpg`
rejected by content; size mismatch; complete before upload; abandon; a PUT cut
mid-transfer then retried; a retry after a PUT whose response was lost; user
JWTs cannot read, list, write or sign in the bucket or call the RPCs; bucket
private, no `storage.objects` policy reaches it, no anon/authenticated grants;
no orphan rows or objects; no token, secret, password or storage path in the
function logs.

Browser (`browser-e2e.mjs`, 40 checks): real sign-in form; Marketing › Media
empty state; JPG, PNG, WebP, H.264 MP4 and VP9 MP4 uploads through the file
input with every hop checked; HEIC refused in Chromium before anything is
reserved; the 13 MiB MP4 by TUS; a cut PUT then Retry (same reservation);
reload with no red banner; search; Photos/Videos/Used/Unused; a collection made
from a selection; photo and video preview; Delete disabled with the reason for
published and scheduled media, and refused by the server when the screen is
stale; delete of unused media; the media service switched off (404 without
CORS) and back; no service key in any request or in localStorage; phone 390.

## Known limits

- Playwright's Chromium has no H.264/AAC decoder: H.264 videos upload and are
  verified by the server, but the browser cannot draw their poster there (the
  tile shows the film icon). The VP9 sample proves the poster/thumbnail path;
  Chrome and Safari decode H.264.
- HEIC: the browser makes the JPEG publish copy (canvas), so only a browser
  that decodes HEIC (Safari) can upload one. Chromium's refusal is checked in
  the browser suite; the server path is checked with a real HEIC and a JPEG
  copy made with Pillow. WebKit is not installed here.
- Image transformations and imgproxy are off (Atlas does not use them).
