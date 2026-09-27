# S94C: Delivery scheduler, worker, concurrency and idempotency design

Scope: the part of the Marketing Publishing Platform that turns approved content into posts on
Instagram, Facebook, TikTok (and later Google Business Profile). It covers the scheduler, the worker,
the delivery state machine, claiming, per-provider idempotency, retries, approval gating, tests and
notifications. This is a design only: no code was edited, and only read-only metadata queries ran on
production.

Status tags: **VERIFIED** means checked in this session against the repository, production metadata or
the official Supabase docs (through the Supabase docs MCP). **UNVERIFIED** means the claim could not be
checked against the provider's own docs, because `developers.facebook.com`, `developers.tiktok.com` and
`supabase.com` are blocked by the egress proxy. Those claims rest on search-result snippets and must be
re-checked before the provider modules are built.

---

## 0. Facts found (repository and production)

| Fact | Evidence | Status |
|---|---|---|
| Production is PostgreSQL 17.6 and the session TimeZone is UTC | `select version(), current_setting('TimeZone')` | VERIFIED |
| Installed extensions: `hypopg`, `index_advisor`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault 0.3.1` (schema `vault`), `uuid-ossp` | `pg_extension` | VERIFIED |
| **`pg_net` is not installed any more.** No `net`, `cron` or `pgmq` schema exists. `pg_net 0.20.4`, `pg_cron 1.6.4`, `pgmq 1.5.1` and `dblink 1.2` are available but not installed | `pg_available_extensions`, `pg_namespace` | VERIFIED |
| `docs/DEPLOYMENT.md:71` still says to drop the temporary `pg_net` from `public`. That has already been done (or it was never kept), so the note is stale. When pg_net is reinstalled for this work, it must go in schema `extensions` (see §1.4), and the note should be replaced | DEPLOYMENT.md, prod | VERIFIED |
| The local replay cluster is PG 16. It has the `dblink` and `pgcrypto` control files, pgbench, and **no** pg_cron, pg_net or pgmq | `/usr/share/postgresql/16/extension`, `/usr/lib/postgresql/16/bin` | VERIFIED |
| Venue clock: `atlas_private.venue_timezone()` returns the Settings value or `Atlantic/Reykjavik`. `venue_date(ts)` and `venue_business_date(ts)` exist in the migration `20260926090000_s88_venue_clock.sql` and in prod. The browser side is `apps/web/assets/js/atlas-venue-clock.js` (`zonedToInstant(dateKey,'HH:MM')`, `formatDateTime`) | repo + prod `pg_proc` | VERIFIED |
| The existing queue pattern is `atlas_private.push_notification_queue` plus `public.atlas_push_notification_claim` (`FOR UPDATE SKIP LOCKED`, status `pending→processing`). It has **no lease or expiry**, so a crashed dispatch leaves rows in `processing` forever | `20260911124039_s34_notification_and_conversation_stars.sql:219` | VERIFIED |
| The `atlas-notifications` dispatch compares `x-atlas-dispatch-token` with `!==`, which is not constant-time. `atlas-ai/handler.mjs:129` has a `timingSafeEqual`, and `:812` requires the secret to be at least 32 characters. Production deploys `atlas-notifications` with `verify_jwt=true`; every other Atlas function has `verify_jwt=false` | source + `list_edge_functions` | VERIFIED |
| Nothing in the repository schedules a push dispatch (no cron job or caller for `?action=dispatch`) | grep | VERIFIED |
| Marketing today: `atlas_private.marketing_content_items` (`status` idea … approved, scheduled, published, cancelled; `platforms text[]`; `scheduled_for`; `external_publication_ids jsonb`), `marketing_content_approvals` (decision rows, no fingerprint), `marketing_workspace_events` (event_type CHECK list) and `marketing_mark_published` (manual) | checkpoint_d migration, prod tables | VERIFIED |
| Credentials: `atlas_private.integration_credentials` has its **primary key on `provider_key`**, so there is one account per provider. `external_account_id` lives on both the credential row and `integration_connections`. Tokens are AES-GCM ciphertext that only the Edge Function can decrypt | `20260926095000_s88_integrations_oauth.sql` | VERIFIED |
| Edge limits: request idle timeout 150 s (504 after it); wall clock 150 s on Free and 400 s on paid plans; 2 s of CPU per request | Supabase docs "Functions → Limits" | VERIFIED (Supabase docs MCP) |

---

## 1. Scheduler mechanism

### 1.1 Recommendation

**Supabase Cron (`pg_cron`) runs every minute and calls `atlas_private.marketing_publisher_tick()`. That
function uses `net.http_post` to send an empty "wake up" to a dedicated internal Edge Function,
`atlas-marketing-publisher`, and authenticates with a shared secret read from Vault. The worker then
claims due deliveries from Postgres through service-role RPCs.**

This is the pattern the Supabase docs describe: "Scheduling Edge Functions" uses pg_cron with pg_net and
stores the URL and key in Vault; "Automatic embeddings" uses pg_cron plus pg_net plus a queue
(VERIFIED). Two properties make the design safe:

* **The tick carries no work.** The body is `{}` (or `{"reason":"cron"}`). The database is the only
  source of truth about what is due. A lost, duplicated, delayed or overlapping tick is therefore
  harmless: pg_net's unlogged request and response tables and its 6-hour response TTL (VERIFIED) do not
  matter, because nothing reads the tick response for correctness.
* **Overlapping workers are expected.** If minute N's worker is still running when minute N+1's tick
  arrives, both run. `SKIP LOCKED` claiming plus leases (§3) keeps them on disjoint rows.

Cron guidance (VERIFIED, docs "Cron"): run at most 8 jobs concurrently and keep each job under
10 minutes. Our job only enqueues an HTTP request, which takes milliseconds. Supabase Cron supports
second-level schedules (for example `'10 seconds'`, used in the embeddings guide). One minute is enough
here, and "publish now" gets an immediate kick (§6).

### 1.2 Alternatives considered

| Option | Verdict |
|---|---|
| **pgmq / Supabase Queues** as the work queue (visibility timeout used as the lease) | **Rejected as the source of truth.** The delivery row already needs a rich, SQL-enforced state machine, provider IDs, approval fingerprints and rate-limit accounting. A pgmq message would be a second copy that can drift from the row, and "exactly once within a visibility window" (docs wording, VERIFIED) is exactly the at-least-once plus lease model we build anyway. Keep pgmq in reserve if volume ever needs fan-out. |
| Edge Function cron from an external scheduler (GitHub Actions, Netlify Scheduled Functions) | Rejected. Timing is imprecise (Actions cron is best-effort) and the worker secret would live outside Supabase. |
| pg_cron calling a SQL function that does the HTTP publishing itself (the `http` extension or pg_net to Meta directly) | Rejected. OAuth tokens are encrypted with a key held only by Edge Functions (S88 design), and pg_net is fire-and-forget: the response is only readable later from an unlogged table, which is unusable for idempotent publishing. |
| Native provider scheduling (Facebook `scheduled_publish_time`, and so on) | Not used as the primary path, because not every provider supports it (IG and TikTok do not). Our scheduler must exist anyway. It could be an optional FB optimisation later. |
| `EdgeRuntime.waitUntil` background tasks started by the gateway | Used only as a best-effort extra for publish-now (§6), never as the scheduler. |

### 1.3 Caller authentication (tick → worker)

* `supabase/config.toml`: `[functions.atlas-marketing-publisher] verify_jwt = false`. Per the Supabase
  docs, the new `sb_secret_…` keys are not JWTs, platform `verify_jwt` only understands the legacy
  JWT keys, and functions called by pg_net should authorise in code (VERIFIED, "Migrating to
  publishable and secret API keys"). Legacy keys keep working until the end of 2026, which is another
  reason not to depend on `verify_jwt` with the service_role JWT.
* **Dedicated shared secret.** Name it `ATLAS_PUBLISHER_TICK_SECRET`: at least 32 random bytes,
  base64url. It is stored twice:
  * as an Edge Function secret (`supabase secrets set`); the reserved `SUPABASE_` prefix is avoided
    (VERIFIED limit);
  * in Vault as `atlas_publisher_tick_secret` (`vault.create_secret(value, name, description)`).
    Vault stores it with authenticated encryption and exposes it through `vault.decrypted_secrets`
    (VERIFIED).
* Header: `x-atlas-publisher-secret: <secret>`. Never put it in the query string: the docs warn that
  URLs are logged.
* Comparison: hash both sides with SHA-256 and constant-time compare the digests. This is the
  `atlas-ai` `timingSafeEqual` pattern with hashing added so length is not leaked. Refuse if the
  configured secret is shorter than 32 characters (fail closed with 503 `not_configured`, as
  `serviceActor` does). Also accept `ATLAS_PUBLISHER_TICK_SECRET_NEXT` during rotation.
* The worker exposes **no browser surface**:
  * no CORS allow-origin;
  * it answers only `POST ?action=tick` and `POST ?action=kick`;
  * every other method or action returns 404;
  * the JSON body is capped at 4 KB;
  * the response carries only counts, never content.

  It is not listed in `apps/web/assets/js/config.js`. The security gate script
  (`verify_phase1_security_gate.sql`) and `edge-auth-contract.test.js` should gain a case: a request
  without the secret gets 401, and no RPC or provider call happens.
* Defence in depth: the service-role RPCs it calls (`marketing_delivery_claim`, …) are `revoke … from
  public, anon, authenticated` and `grant … to service_role`, so a leaked tick secret gives only the
  ability to *wake* the worker, never to choose what it publishes.
* The function reaches its own project URL through `SUPABASE_URL` and uses the secret key
  (`SUPABASE_SECRET_KEYS['default']` or the legacy `SUPABASE_SERVICE_ROLE_KEY`, whichever Atlas
  standardises on) only for PostgREST RPCs, following the pattern in `atlas-integrations/index.ts`.

### 1.4 SQL sketch (owner-run rollout step; see the replay note below)

```sql
-- Install into `extensions`, not `public` (the S90 mistake DEPLOYMENT.md mentions).
create extension if not exists pg_net with schema extensions;   -- creates schema net for its API
create extension if not exists pg_cron;                          -- creates schema cron

-- Owner, once, in the SQL editor (never in a migration file: the value must not be in git):
--   select vault.create_secret('<https://dnefgcmjcgxlynycxkts.supabase.co>', 'atlas_project_url');
--   select vault.create_secret('<32+ byte random>', 'atlas_publisher_tick_secret',
--                              'x-atlas-publisher-secret for atlas-marketing-publisher');

create or replace function atlas_private.marketing_publisher_tick(p_reason text default 'cron')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text; v_secret text; v_due boolean;
begin
  -- Cheap guard: do not wake the function when there is nothing to do.
  select exists (
    select 1 from atlas_private.marketing_deliveries d
    where d.status in ('queued','retrying','processing','verifying','publishing')
      and d.next_attempt_at <= pg_catalog.now()
      and (d.claimed_until is null or d.claimed_until < pg_catalog.now())
  ) into v_due;
  if not v_due then return null; end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'atlas_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'atlas_publisher_tick_secret';
  if v_url is null or v_secret is null then
    raise warning 'marketing publisher tick is not configured';
    return null;
  end if;

  return net.http_post(
    url := v_url || '/functions/v1/atlas-marketing-publisher?action=tick',
    body := jsonb_build_object('reason', left(coalesce(p_reason,'cron'), 20)),
    headers := jsonb_build_object('content-type','application/json',
                                  'x-atlas-publisher-secret', v_secret),
    timeout_milliseconds := 60000
  );
end;
$$;
revoke all on function atlas_private.marketing_publisher_tick(text) from public, anon, authenticated;

select cron.schedule('atlas-marketing-publisher-tick', '* * * * *',
                     $$select atlas_private.marketing_publisher_tick('cron')$$);
-- Keep job history bounded (cron.job_run_details grows forever):
select cron.schedule('atlas-cron-history-trim', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
```

Notes:

* **Replay compatibility.** The local PG16 replay has no pg_cron or pg_net. The migration must therefore
  create only the tables, RPCs and `marketing_publisher_tick()`. Its `net.http_post` call is resolved at
  run time in plpgsql, so creating the function succeeds without pg_net. The `create extension` and
  `cron.schedule` statements go in an owner-run script, for example
  `supabase/production-launch/s94_publisher_schedule.sql`, guarded by
  `if exists (select 1 from pg_available_extensions where name='pg_cron')`, and are documented in
  DEPLOYMENT.md. This also keeps the kill switch simple: `select cron.unschedule('atlas-marketing-publisher-tick')`.
* The tick runs as the cron job owner (`postgres`), so reading `vault.decrypted_secrets` works. The
  function is `security definer` with an empty search_path and execute revoked, so no API role can call
  it. `vault.decrypted_secrets` must stay revoked from `anon` and `authenticated` (it is by default,
  VERIFIED guidance: "protect access to this view").
* pg_net's `timeout_milliseconds` (default 2000, VERIFIED) is raised to 60 s. What happens to an Edge
  Function when the calling client disconnects is **UNVERIFIED**. The worker therefore must not depend
  on the tick connection staying open: it limits itself to a **45-second work budget per invocation**
  (well under the 150 s idle timeout), and leases (§3) are longer than that budget.
* A second job can later wake `atlas-notifications?action=dispatch` the same way (§9). That function
  runs with `verify_jwt=true` in production and uses a non-constant-time compare, so fix both first.

### 1.5 Worker loop (`atlas-marketing-publisher/handler.mjs`, injected `env`, `fetch`, `rpc`, `now`, `random`)

```
tick():
  authenticate (constant-time)                       -> 401 otherwise, nothing else runs
  deadline = now + 45s
  loop while now < deadline - 10s:
    batch = rpc('marketing_delivery_claim', {p_worker_id, p_limit: 4, p_lease_seconds: 300})
    if batch empty: break
    for each claimed delivery (sequentially per provider account, providers in parallel):
      step(delivery)          # one state-machine step, see §4; each step records before and after
  return {claimed, published, processing, retrying, verifying, needs_attention, failed}
```

The worker decrypts provider tokens with the same key module as `atlas-integrations`. The recommendation
is to move the AES-GCM helpers into `_shared/integration-crypto.mjs` and have both functions read
`ATLAS_INTEGRATIONS_ENCRYPTION_KEY`, or whatever name S88 uses. Token refresh reuses
`integration_store_credential` so there is only one refresh path. Coordinate this with the credentials
agent.

---

## 2. Delivery model

### 2.1 Granularity

There is one **delivery** per `(content_id, provider_key, external_account_id, target_kind)`.
`target_kind` covers the placement:

* `ig_feed`, `ig_reel`, `ig_story`, `ig_carousel`;
* `fb_page_post`, `fb_page_photo`, `fb_reel`;
* `tiktok_video`, `tiktok_photo`;
* `gbp_local_post`.

Today `integration_credentials` holds one account per provider, but the key includes
`external_account_id` so a second IG account or FB Page does not need a new schema.

### 2.2 Tables (sketch)

```sql
create table atlas_private.marketing_deliveries (
  id                     uuid primary key default gen_random_uuid(),
  content_id             uuid not null references atlas_private.marketing_content_items(id) on delete restrict,
  provider_key           text not null references atlas_private.integration_connections(provider_key),
  external_account_id    text not null check (length(external_account_id) between 1 and 200),
  target_kind            text not null check (target_kind in ('ig_feed','ig_reel','ig_story','ig_carousel',
                           'fb_page_post','fb_page_photo','fb_reel','tiktok_video','tiktok_photo','gbp_local_post')),
  -- Approval binding (§7)
  approval_id            uuid not null references atlas_private.marketing_content_approvals(id),
  approved_fingerprint   bytea not null check (octet_length(approved_fingerprint) = 32),
  payload_snapshot       jsonb not null check (jsonb_typeof(payload_snapshot) = 'object'),  -- frozen caption/media/options
  -- Scheduling
  status                 text not null default 'queued' check (status in
                           ('queued','publishing','processing','verifying','retrying',
                            'published','failed','needs_attention','cancelled')),
  due_at                 timestamptz not null,            -- the approved scheduled instant (UTC)
  next_attempt_at        timestamptz not null,            -- due_at, or the backoff / poll time
  latest_acceptable_at   timestamptz not null,            -- after this, never auto-publish (stale guard)
  priority               smallint not null default 100,   -- publish-now uses 10
  -- Claiming / lease (§3)
  claim_token            uuid,
  claimed_by             text,
  claimed_until          timestamptz,
  attempt_count          integer not null default 0 check (attempt_count >= 0),
  max_attempts           integer not null default 6 check (max_attempts between 1 and 20),
  poll_count             integer not null default 0,
  -- Idempotency / provider progress (§4)
  phase                  text not null default 'none' check (phase in
                           ('none','media_ready','container_created','container_ready',
                            'submitting','submitted','remote_processing')),
  provider_container_id  text,          -- IG container (creation_id)
  provider_publish_id    text,          -- TikTok publish_id
  provider_post_id       text,          -- final IG media id / FB post id / TikTok post id / GBP name
  provider_permalink     text check (provider_permalink is null or provider_permalink ~ '^https://'),
  submit_started_at      timestamptz,   -- written (committed) BEFORE the non-idempotent call
  verify_attempts        integer not null default 0,
  -- Outcome
  published_at           timestamptz,
  published_source       text check (published_source in ('provider','verification','manual')),
  last_error_class       text check (last_error_class in ('transient','rate_limited','auth','permanent',
                           'uncertain','stale','policy')),
  last_error_code        text check (length(last_error_code) <= 80),
  last_error_message     text check (length(last_error_message) <= 500),   -- sanitised, no tokens
  attention_reason       text check (attention_reason in ('outcome_unknown','auth_expired','rate_limit_exhausted',
                           'max_attempts','stale_schedule','provider_rejected','media_invalid','manual_hold')),
  attention_notified_at  timestamptz,
  cancel_requested_at    timestamptz,
  cancelled_at           timestamptz,
  cancelled_reason       text check (cancelled_reason in ('user','superseded_by_edit','content_cancelled','provider_disconnected')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  row_version            integer not null default 1,
  constraint deliveries_published_has_id check (status <> 'published' or provider_post_id is not null
                                                 or published_source = 'manual'),
  constraint deliveries_claim_complete check ((claim_token is null) = (claimed_until is null)),
  constraint deliveries_publishing_claimed check (status <> 'publishing' or claim_token is not null),
  constraint deliveries_submit_marker check (phase not in ('submitting','submitted') or submit_started_at is not null),
  constraint deliveries_stale_after_due check (latest_acceptable_at >= due_at)
);

-- One live delivery per target. A cancelled one can be replaced (re-approval after an edit).
create unique index marketing_deliveries_live_target_uidx
  on atlas_private.marketing_deliveries (content_id, provider_key, external_account_id, target_kind)
  where status <> 'cancelled';
-- A provider object can back exactly one delivery (catches a verify step matching the wrong row).
create unique index marketing_deliveries_post_uidx      on atlas_private.marketing_deliveries (provider_key, provider_post_id)      where provider_post_id is not null;
create unique index marketing_deliveries_container_uidx on atlas_private.marketing_deliveries (provider_key, provider_container_id) where provider_container_id is not null;
create unique index marketing_deliveries_publish_uidx   on atlas_private.marketing_deliveries (provider_key, provider_publish_id)   where provider_publish_id is not null;
-- Claim path index
create index marketing_deliveries_due_idx on atlas_private.marketing_deliveries (next_attempt_at, priority, id)
  where status in ('queued','retrying','processing','verifying','publishing');
create index marketing_deliveries_account_published_idx
  on atlas_private.marketing_deliveries (provider_key, external_account_id, published_at desc)
  where published_at is not null;

-- Append-only attempt ledger: one row per claim, with every provider step.
create table atlas_private.marketing_delivery_attempts (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references atlas_private.marketing_deliveries(id) on delete cascade,
  attempt_no    integer not null,
  claim_token   uuid not null unique,
  claimed_by    text not null,
  claim_kind    text not null check (claim_kind in ('publish','poll','verify','recover')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  steps         jsonb not null default '[]'::jsonb,   -- [{step, at, http_status, provider_request_id, outcome}]
  outcome       text check (outcome in ('published','processing','retrying','verifying','failed','needs_attention','lease_lost')),
  unique (delivery_id, attempt_no),
  constraint attempts_steps_no_secrets check (steps::text !~* '"(access_token|refresh_token|token|secret|authorization)"\s*:')
);

-- Per-account provider state for rate limits (§3.4)
create table atlas_private.marketing_provider_accounts (
  provider_key         text not null references atlas_private.integration_connections(provider_key),
  external_account_id  text not null,
  cooldown_until       timestamptz,             -- set on 429 / publishing-limit responses
  daily_publish_cap    integer,                 -- e.g. IG 100 (provider), Atlas safety cap lower
  last_quota_check_at  timestamptz,
  last_quota_usage     integer,
  primary key (provider_key, external_account_id)
);
```

All three tables get RLS on, a service-role-only policy, `revoke all … from public, anon, authenticated`
and grants to service_role only, following the S88 pattern exactly. Writes go only through definer RPCs.
Direct `UPDATE` is revoked even from service_role on `marketing_deliveries` if the team wants the
strictest stance (as S89/S90 did for `inventory_items`); otherwise the transition trigger below still
enforces the state machine.

### 2.3 State machine

```
            ┌──────────── cancel (not in flight) ─────────────┐
            v                                                  │
 queued ──claim──> publishing ──ok──────────────────> published (terminal)
   ^  ^               │  │  │                              ^   ^
   │  │  safe error   │  │  └─ async accepted ─> processing ┘   │
   │  └── retrying <──┘  │                       │ │ │          │
   │        ^ (claim     │ uncertain after       │ │ └ poll err/timeout > verifying
   │        │ → publishing) submitting ─> verifying ─┘  (found) ─┘
   │        └──── verified absent + safe ───────┘
   │
   └── manager requeue ── needs_attention / failed ── manager "mark posted" ─> published (manual)
```

Legal transitions (from → to). Every other change is refused by a `BEFORE UPDATE` trigger with SQLSTATE
`P0001` and message `illegal delivery transition <from>→<to>`:

| From | To | Guard (checked in trigger or RPC) |
|---|---|---|
| queued | publishing | claim RPC only; claim_token set; approval gate holds (§7) |
| queued | cancelled | not in flight |
| retrying | publishing | as for queued; `attempt_count < max_attempts` |
| retrying | cancelled | — |
| retrying | needs_attention | stale (`now() > latest_acceptable_at`) |
| publishing | published | `provider_post_id` set, token matches |
| publishing | processing | provider accepted async (TikTok publish_id, IG container IN_PROGRESS); the matching ID is persisted |
| publishing | retrying | **only if `phase` ∉ ('submitting','submitted')**, meaning the error happened before the non-idempotent call |
| publishing | verifying | phase = 'submitting' and the outcome is unknown (timeout, 5xx, reset, lease expiry) |
| publishing | failed | permanent provider rejection that proves nothing was created |
| publishing | needs_attention | auth expired, max attempts, stale, policy |
| processing | published / failed / needs_attention / verifying | poll outcome |
| processing | publishing | IG only: container FINISHED, so this claim goes on to media_publish (phase container_ready) |
| verifying | published | provider shows the post (source = 'verification') |
| verifying | retrying | the provider **proves** absence and the retry point is safe (§4) |
| verifying | needs_attention | cannot prove either way within the verify budget |
| failed | queued | manager retry RPC; refused if `phase in ('submitting','submitted')` unless the manager attests (`p_confirmed_not_posted = true`, recorded in events) |
| needs_attention | queued | same rule as failed → queued; also re-checks the approval gate |
| needs_attention | published | manager "mark as posted" with a permalink (`published_source='manual'`) |
| needs_attention / failed | cancelled | — |
| published, cancelled | anything | **never** (terminal) |

Same-status updates (lease renewal, poll bookkeeping) are allowed only while the caller holds the lease.
In practice the trigger allows `old.status = new.status` and lets the RPCs enforce the token.

Cancelling an in-flight row (`publishing`, `processing`, `verifying`) is not a transition. It sets
`cancel_requested_at`, and the worker honours it at the next safe point: before `submitting` it goes to
cancelled; after that it continues to a truthful outcome. A post that may already exist cannot be
"cancelled", only reported.

Trigger sketch:

```sql
create table atlas_private.marketing_delivery_transitions (
  from_status text not null, to_status text not null, primary key (from_status, to_status));
insert into atlas_private.marketing_delivery_transitions values
 ('queued','publishing'),('queued','cancelled'),
 ('retrying','publishing'),('retrying','cancelled'),('retrying','needs_attention'),
 ('publishing','published'),('publishing','processing'),('publishing','retrying'),('publishing','verifying'),
 ('publishing','failed'),('publishing','needs_attention'),
 ('processing','published'),('processing','failed'),('processing','needs_attention'),('processing','verifying'),
 ('processing','publishing'),
 ('verifying','published'),('verifying','retrying'),('verifying','needs_attention'),
 ('failed','queued'),('failed','cancelled'),
 ('needs_attention','queued'),('needs_attention','published'),('needs_attention','cancelled');

create or replace function atlas_private.marketing_delivery_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from atlas_private.marketing_delivery_transitions t
                   where t.from_status = old.status and t.to_status = new.status) then
      raise exception 'illegal delivery transition %→%', old.status, new.status using errcode = 'P0001';
    end if;
    if old.status = 'publishing' and new.status = 'retrying'
       and old.phase in ('submitting','submitted') then
      raise exception 'unsafe retry after submit; verify first' using errcode = 'P0001';
    end if;
  end if;
  -- Provider IDs are write-once: an ID, once learned, can never be changed or cleared.
  if old.provider_post_id is not null and new.provider_post_id is distinct from old.provider_post_id
     or old.provider_publish_id is not null and new.provider_publish_id is distinct from old.provider_publish_id then
    raise exception 'provider ids are write-once' using errcode = 'P0001';
  end if;
  -- IG container may be replaced only after it was proven expired and unpublished (the RPC sets a flag in
  -- the attempt steps; the trigger allows a change only when phase is being reset to 'none' from 'verifying').
  new.updated_at := now(); new.row_version := old.row_version + 1;
  return new;
end $$;
create trigger marketing_delivery_guard before update on atlas_private.marketing_deliveries
  for each row execute function atlas_private.marketing_delivery_guard();
```

### 2.4 Content-level status

The content row's status comes from its deliveries and is recomputed inside the same RPC transaction by
`atlas_private.marketing_content_refresh_publication(content_id)`:

* all deliveries published → `published`, with `published_at = max(published_at)` and
  `external_publication_ids` rebuilt from the delivery rows (keeping the existing jsonb column
  compatible with `marketing_mark_published` readers);
* some published and some not → keep `scheduled`, plus a derived `publication_state = 'partial'` in the
  snapshot (no new enum value, so older readers are unaffected);
* any needs_attention → the snapshot flag `attention = true`.

Coordinate the exact field names with the data-model design.

---

## 3. Claiming

### 3.1 RPC contract

`atlas_private.marketing_delivery_claim(p_worker_id text, p_limit int default 4, p_lease_seconds int default 300) returns jsonb`

This is a `security definer`, `set search_path=''` function, executable by service_role only. It
returns an array of claims: `{delivery, payload_snapshot, claim_token, claim_kind, lease_until,
credential_ref}`. It never returns plaintext tokens; the worker reads credentials through the existing
`integration_read_credential` path.

Every worker write afterwards is a separate RPC that takes `(p_delivery_id, p_claim_token)` and **fences**
on it:

```sql
update atlas_private.marketing_deliveries d set …
where d.id = p_delivery_id and d.claim_token = p_claim_token and d.claimed_until > now()
returning …;
-- 0 rows  ->  return {"lease_lost": true}; the worker must stop touching this delivery.
```

RPCs:

| RPC | Purpose |
|---|---|
| `marketing_delivery_claim` | recover stale leases, gate, then claim |
| `marketing_delivery_heartbeat(id, token, seconds)` | extend the lease (only if still owned) |
| `marketing_delivery_record_step(id, token, phase, ids jsonb, step jsonb)` | persist provider IDs and phase **before** the next call |
| `marketing_delivery_begin_submit(id, token)` | the **submitting marker**: re-checks the approval gate, cancel request, stale guard and rate budget, sets `phase='submitting'` and `submit_started_at=now()`, extends the lease, commits. The worker makes the non-idempotent call only after this returns `ok` |
| `marketing_delivery_complete(id, token, outcome jsonb)` | move to published / processing / retrying / verifying / failed / needs_attention; computes backoff in SQL; releases the claim; writes events and notifications |
| `marketing_delivery_manager_*` (invoker wrappers, manager check, via `atlas-marketing-workspace`) | requeue, mark posted, cancel |

### 3.2 Claim body (sketch)

PostgreSQL does not allow `FOR UPDATE` together with window functions or `DISTINCT`. The fairness
ranking is therefore computed in an unlocked CTE, and a second `SELECT … FOR UPDATE SKIP LOCKED`
re-checks every predicate on the rows it locks.

```sql
-- (a) Stale-lease recovery: rows whose lease ran out while in flight.
with stale as (
  select d.id from atlas_private.marketing_deliveries d
  where d.claimed_until < now()
  for update skip locked
)
update atlas_private.marketing_deliveries d set
  status = case
             when d.status = 'publishing' and d.phase in ('submitting','submitted') then 'verifying'
             when d.status = 'publishing' then 'retrying'          -- died before the unsafe call: safe
             else d.status end,                                   -- processing / verifying keep status
  claim_token = null, claimed_until = null, claimed_by = null,
  next_attempt_at = now(),
  last_error_class = case when d.status = 'publishing' then 'uncertain' else d.last_error_class end
from stale where d.id = stale.id;
-- (the matching attempt rows get outcome 'lease_lost')

-- (b) Candidates, fairness and gates (no locks yet).
with gate as (
  select d.id, d.provider_key, d.external_account_id, d.priority, d.next_attempt_at
  from atlas_private.marketing_deliveries d
  join atlas_private.marketing_content_items c on c.id = d.content_id
  join atlas_private.marketing_content_approvals a on a.id = d.approval_id
  join atlas_private.integration_connections ic on ic.provider_key = d.provider_key
  left join atlas_private.marketing_provider_accounts pa
         on pa.provider_key = d.provider_key and pa.external_account_id = d.external_account_id
  where d.status in ('queued','retrying','processing','verifying')
    and d.next_attempt_at <= now()
    and d.claim_token is null
    and d.cancel_requested_at is null
    and ic.status = 'connected'
    and (pa.cooldown_until is null or pa.cooldown_until <= now())
    and ( d.status in ('processing','verifying')        -- polls and verifies are always allowed:
          or atlas_private.marketing_delivery_gate_ok(d, c, a) )   -- approval gate (§7) and stale guard
    and ( d.status in ('processing','verifying')
          or atlas_private.marketing_account_budget_ok(d.provider_key, d.external_account_id) )
), ranked as (
  select g.*, row_number() over (partition by g.provider_key, g.external_account_id
                                 order by g.priority, g.next_attempt_at, g.id) as rn
  from gate g
)
select id from ranked where rn <= 2                     -- at most 2 per account per claim (fairness)
order by priority, next_attempt_at, id
limit greatest(1, least(p_limit, 20));

-- (c) Lock with SKIP LOCKED and re-check (the state may have changed between b and c).
select d.* from atlas_private.marketing_deliveries d
where d.id = any(candidate_ids)
  and d.claim_token is null
  and d.status in ('queued','retrying','processing','verifying')
  and d.next_attempt_at <= now()
for update skip locked;

-- (d) Claim.
update … set claim_token = gen_random_uuid(), claimed_by = p_worker_id,
             claimed_until = now() + make_interval(secs => p_lease_seconds),
             status = case when status in ('queued','retrying') then 'publishing' else status end,
             attempt_count = attempt_count + case when status in ('queued','retrying') then 1 else 0 end,
             poll_count = poll_count + case when status = 'processing' then 1 else 0 end,
             verify_attempts = verify_attempts + case when status = 'verifying' then 1 else 0 end;
insert into atlas_private.marketing_delivery_attempts (...);
```

Rules:

* **Stale detection for queued rows.** If `now() > latest_acceptable_at` on a queued or retrying row, the
  claim moves it to `needs_attention` (`attention_reason='stale_schedule'`) instead of publishing it
  late. The default is `latest_acceptable_at = due_at + 6 hours`. For event promotions it is
  `least(due_at + 6h, event_starts_at)`. Posting "Tonight: live DJ" the next morning is worse than not
  posting.
* **Lease length.** 300 s, which is longer than the 45 s worker budget plus the 60 s pg_net timeout. The
  worker calls heartbeat before any long provider call (a video upload). Before every non-idempotent
  call the worker must have at least 90 s of lease left; `begin_submit` extends it.
* **Fencing after lease loss.** Suppose a worker stalls, its lease expires, a second worker recovers the
  row and the first worker wakes up. The first worker's `record_step` and `complete` calls return
  `lease_lost` and do nothing. If the first worker had already sent the provider call before stalling,
  the row was `submitting`, so recovery moved it to `verifying` and not to `retrying`. No blind
  republish is possible.
* **Fairness.** There are three levers: a cap per account per claim (2), `priority` (publish-now 10 before
  scheduled 100), and oldest `next_attempt_at` first. Polls and verifies go through the same claim but
  cost no publish budget.

### 3.3 Why a row cannot be published twice by two workers

1. `FOR UPDATE SKIP LOCKED` together with `claim_token is null` in the locked re-check means only one
   transaction can set the token.
2. Every later write is fenced on `(id, claim_token, claimed_until > now())`.
3. The only way back to a claimable publishing state after the submitting marker is through
   `verifying`, and the trigger refuses `publishing→retrying` when `phase='submitting'`.
4. The unique partial index allows only one live delivery per target, and the write-once provider ID
   columns stop a verify step from attaching a second post to the same row.

### 3.4 Rate-limit awareness

* **Instagram.** 100 API-published posts per IG account in a rolling 24 h; carousels count as one; the
  limit is enforced on `media_publish`; usage is available from `GET /{ig-user-id}/content_publishing_limit`
  (UNVERIFIED: search snippets, and the Meta docs page is blocked). `marketing_account_budget_ok`
  counts `published_at > now() - 24h` plus the rows in submitting or submitted for that account, and
  compares the total with `least(provider_cap, atlas_cap)`. Atlas cap default: 25/day, which is far above
  a bar's need and catches runaway loops. The worker also calls `content_publishing_limit` before
  `media_publish` whenever `last_quota_check_at` is more than 10 minutes old, and stores the value. If the
  budget is exhausted, the row stays queued with `next_attempt_at = oldest publish in window + 24h +
  jitter`. It becomes `needs_attention('rate_limit_exhausted')` only if that time is past
  `latest_acceptable_at`.
* **TikTok.** 6 `init` requests per minute and 30 `status/fetch` per minute per user token (UNVERIFIED).
  The claim cap of 2 per account per tick and a poll cadence of 30 s or more keep us well inside this.
  A 429 sets `cooldown_until = now() + max(Retry-After, 60s)`.
* **Facebook Pages and Graph in general.** Business Use Case limits come back in the
  `X-Business-Use-Case-Usage` and `X-App-Usage` headers (UNVERIFIED names). The worker parses them;
  above 80 % it sets `cooldown_until` from `estimated_time_to_regain_access`.
* Every 429 or "limit reached" provider code maps to `rate_limited` (§5), which is always a safe-point
  retry *only when the provider rejected the request*. A rejected request did not create anything.

---

## 4. Idempotency per provider

General rule: **persist → mark → call → persist**.

* Every provider ID is written (committed) through `record_step` **before** the step that consumes it.
* Every non-idempotent call is preceded by the committed `begin_submit` marker.
* After an uncertain outcome (timeout, connection reset, 5xx, lease loss) of a non-idempotent call, the
  only path is **verify**: query the provider. It never retries blindly.
* Retries happen only from **safe points**, meaning phases where repeating the step cannot create a
  second public post.

### 4.1 Instagram (container → publish)

| Step | Call | Idempotent? | Persist | On failure |
|---|---|---|---|---|
| 1 media_ready | sign the media URL from Storage (short-lived) and check hash = snapshot hash | yes | phase media_ready | retry |
| 2 container | `POST /{ig-user-id}/media` (image_url / video_url, caption, media_type) → `id` | **no, but harmless**: an unpublished container is private and expires after 24 h (VERIFIED by search: EXPIRED means "not published within 24 hours") | `provider_container_id`, phase container_created | lost response → retry creates another container. Safe, because nothing is public; the orphan expires |
| 3 wait | `GET /{container-id}?fields=status_code` → IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED (the PUBLISHED value is UNVERIFIED on the official page but documented by libraries) | yes | phase container_ready when FINISHED; status `processing` while IN_PROGRESS | ERROR → failed (media rejected); EXPIRED → back to step 2 (nothing was published) |
| 4 publish | `begin_submit`, then `POST /{ig-user-id}/media_publish?creation_id={container}` → media `id` | **naturally idempotent per container**: one container yields at most one media (reported widely; UNVERIFIED on Meta's page) | `provider_post_id`, permalink (`GET /{media-id}?fields=permalink`) | uncertain → verifying |
| verify | `GET /{container}?fields=status_code`. PUBLISHED → find the media: `GET /{ig-user-id}/media?fields=id,caption,timestamp,permalink&limit=10`, match `timestamp >= submit_started_at - 2 min` and the caption hash. FINISHED → proven not published → `retrying`, and re-publish **the same container** | yes | — | PUBLISHED but no media match after 3 verifies → needs_attention('outcome_unknown') with the container ID recorded. EXPIRED after submit → needs_attention (cannot prove) |

Carousels: children containers go in `payload.children_container_ids` (persisted), the parent container
in `provider_container_id`, with the same rule.

### 4.2 TikTok (Content Posting API, Direct Post)

| Step | Call | Idempotent? | Persist | On failure |
|---|---|---|---|---|
| 1 creator info | `POST /v2/post/publish/creator_info/query/` → privacy options, max duration | yes | options in the attempt steps | auth → needs_attention |
| 2 init | `begin_submit`, then `POST /v2/post/publish/video/init/` (PULL_FROM_URL from a verified domain, or FILE_UPLOAD) → `publish_id` | **no**: with PULL_FROM_URL, init *is* the publish request. TikTok documents no idempotency key (UNVERIFIED) | `provider_publish_id`, phase submitted, status processing | lost response → verifying |
| 3 poll | `POST /v2/post/publish/status/fetch/ {publish_id}` → PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE, FAILED (+`fail_reason`, `publicaly_available_post_id[]`) (UNVERIFIED names) | yes | `provider_post_id` when available | FAILED with a pre-publish reason (download failed, file format, duration) → `failed`, or `retrying` with a new init, because TikTok states the post was not created. Other or unknown fail_reason → needs_attention |
| verify (no publish_id) | TikTok has no "find my init" lookup. If the account granted `video.list`, `POST /v2/video/list/` for recent videos, matched on `create_time >= submit_started_at` and title/caption | yes | — | no `video.list` scope, or no match after moderation time → **needs_attention**, never re-init |

Moderation may take hours (UNVERIFIED snippet: "usually within one minute… in some cases a few hours").
Status stays `processing` with the poll cadence in §5.3 up to 24 h, then needs_attention.

### 4.3 Facebook Page

| Step | Call | Idempotent? | Persist | On failure |
|---|---|---|---|---|
| publish | `begin_submit`, then `POST /{page-id}/feed` (message, link), `POST /{page-id}/photos` (url, caption), or multi-photo (unpublished photos, then feed with `attached_media`) | **no idempotency at all** | `provider_post_id` (`id` or `post_id`) | uncertain → verifying |
| (multi-photo) | unpublished `POST /{page-id}/photos?published=false` → photo ids | harmless (unpublished) | `payload.child_media_ids` | retry safe |
| verify | `GET /{page-id}/published_posts?since={submit_started_at-120s}&fields=id,message,created_time,permalink_url` (UNVERIFIED field list; Meta docs blocked), matched on the exact message text hash and `created_time` | yes | — | exactly one match → published (verification). Zero matches on **two reads at least 2 minutes apart** → verified absent → one `retrying`; a second uncertain outcome → needs_attention. More than one match → needs_attention |

The Page listing is the provider's own authoritative source for a synchronous create, so reading it twice
and finding nothing counts as proof. Allow at most one such automated retry per delivery
(`verify_retry_used` flag in the steps), and let the team switch it off (`auto_retry_after_verified_absence=false`
in the provider settings) if they prefer every ambiguity to go to a human.

### 4.4 Google Business Profile (later)

`accounts/*/locations/*/localPosts.create` has no idempotency. Verify with `localPosts.list`, matched on
`summary` and `createTime`. Same rules as Facebook.

### 4.5 Proof: "Instagram succeeded, TikTok retry never republishes Instagram"

* **Structural.** IG and TikTok are separate delivery rows. Every worker action is keyed by one
  `delivery_id` and fenced by that row's `claim_token`. A TikTok failure only transitions the TikTok row.
* **Terminal.** The IG row is `published`. The trigger refuses every transition out of `published`, and
  the claim predicate never selects it (status is not in queued, retrying, processing or verifying).
* **No re-fan-out.** Retries never re-run "create deliveries for content". Deliveries are created once, at
  approval, by `marketing_content_approve` (`insert … on conflict do nothing` on the live-target unique
  index). The manager "retry failed" action on a content item acts only on rows in
  `failed`/`needs_attention`, row by row, and refuses published rows.
* **Uniqueness.** Even a buggy second insert for the IG target collides with
  `marketing_deliveries_live_target_uidx`.
* **Test** (§8.2 T3): tick 1: IG publishes, TikTok init returns 500 before accepting (safe) → TikTok
  `retrying`. Advance the clock and run tick 2. Assert that the fake Graph API recorded exactly one
  `media` and one `media_publish` call across both ticks, that tick 2 made zero IG calls, and that the IG
  row's `row_version` did not change. Add a SQL variant: `update … set status='queued'` on the published
  IG row must raise.

---

## 5. Retry classification and backoff

### 5.1 Classification (worker `classify(provider, step, response|error)`)

| Class | Examples | Before submit marker | After submit marker |
|---|---|---|---|
| `transient` | network error, DNS, 5xx, 408, timeout, Graph `is_transient=true`, codes 1/2 | retrying (backoff) | **verifying** |
| `rate_limited` | 429, Graph 4/17/32/613, IG publishing-limit error (code 9 or subcode 2207042; UNVERIFIED), TikTok `rate_limit_exceeded` | retrying + account cooldown | only if the provider *rejected* the request (definitive 4xx body) → retrying; otherwise verifying |
| `auth` | Graph 190 / OAuthException, 10/200-series permission errors, TikTok `access_token_invalid`, `scope_not_authorized` | needs_attention('auth_expired'); also `integration_record_result('verify_failed')` so the Integrations screen shows it | same, but through verifying first if the response was not a definitive rejection |
| `permanent` | media invalid (IG container ERROR, aspect ratio, 9004), caption too long, TikTok `spam_risk…`, duplicate content policy | failed('provider_rejected' / 'media_invalid') | failed only if the error body is a definitive rejection; else verifying |
| `uncertain` | anything else after the marker: no response, unparseable body, 5xx after submit | — | verifying |
| `stale` | now > latest_acceptable_at | needs_attention | (n/a: marker is refused by begin_submit) |
| `policy` | approval fingerprint mismatch, content cancelled, connection disconnected | cancelled (`superseded_by_edit` / `content_cancelled`) or needs_attention | refused by begin_submit, so no call is made |

Unknown error shapes default to the **safer** class: `transient` before the marker, `uncertain` after.

### 5.2 Backoff (computed in SQL inside `complete`, so it is tested in one place)

```sql
create or replace function atlas_private.marketing_backoff(p_attempt int, p_base_s int default 60,
                                                          p_cap_s int default 3600, p_retry_after_s int default null)
returns interval language sql volatile set search_path = '' as $$
  select make_interval(secs => greatest(
           coalesce(p_retry_after_s, 0),
           -- "equal jitter": half fixed + half random, so it never retries immediately
           (least(p_cap_s, p_base_s * power(2, greatest(p_attempt,1) - 1)) / 2.0)
           * (1 + random())));
$$;
```

* Attempt 1: 30–60 s; 2: 60–120 s; 3: 2–4 min; 4: 4–8 min; 5: 8–16 min; 6: 16–32 min. The cap is 1 h.
* `max_attempts = 6` publish claims. Exhausted → needs_attention('max_attempts').
* The stale guard wins over backoff: if `now() + backoff > latest_acceptable_at`, go to needs_attention
  now.
* Retry-After (seconds or HTTP date) is honoured and also sets the account `cooldown_until`.
* Tests inject `random()` by calling the function with a fixed `setseed()` in SQL. In Node, the worker
  never computes backoff; it only passes the `retry_after` it saw.

### 5.3 Poll schedules (async providers; `processing` status does not consume `attempt_count`)

| Provider | Inline in the same invocation | Then `next_attempt_at` cadence | Give up |
|---|---|---|---|
| IG container (image) | 3 polls at 2 s, 4 s, 8 s | 1 min, 1, 2, 5, 5, 10 … | 60 min → needs_attention (container still valid for 24 h, so a manager can requeue) |
| IG container (reel/video) | 2 polls at 5 s, 10 s | 1 min, 2, 5, 5, 10 … | 2 h |
| TikTok status | none inline (30 fetches per minute budget) | 30 s, 1 min, 2, 5, 10, 15, then every 15 min | 24 h |
| Verify (all) | — | 1 min, 2, 5 | 3 verifies (IG/TikTok), 2 reads at least 2 min apart (FB) → needs_attention |

---

## 6. Publish now

`public.atlas_marketing_publish_now(p_content_id, p_actor…)` is an invoker wrapper with a manager check,
over the definer `atlas_private.marketing_publish_now`:

1. Lock the content row. Require the approval gate (§7), with one difference: publish-now does **not**
   change `scheduled_for`. It sets `due_at = next_attempt_at = now()`, `priority = 10` and
   `latest_acceptable_at = now() + 30 min` on the delivery rows that are `queued` or `retrying`.
   Changing only the delivery's due time does not alter the approved fingerprint (§7), and the
   `publish_now` event records the override.
   *Alternative if the product wants it:* treat "publish now" as a schedule edit that needs
   re-approval. This is not recommended, because a manager pressing it is already the approver role.
2. The call is idempotent. A double click finds rows already due or in `publishing` and changes nothing
   (`on conflict do nothing` / `where status in ('queued','retrying')`).
3. After the RPC commits, the `atlas-marketing-workspace` gateway kicks the worker:
   `fetch(SUPABASE_URL + '/functions/v1/atlas-marketing-publisher?action=kick', { headers: {'x-atlas-publisher-secret': env.ATLAS_PUBLISHER_TICK_SECRET}, signal: AbortSignal.timeout(2500) })`.
   It is wrapped in `EdgeRuntime.waitUntil` where available, and errors are swallowed and logged. If the
   kick fails, the next minute's cron tick publishes, so worst-case latency is about 60 s. The gateway
   answers the browser with `{status:'queued'}` straight away, and the UI polls the snapshot.
4. `?action=kick` is the same code path as `tick`: it claims due rows, and publish-now rows win on
   priority. No separate "publish immediately" code exists, so there is nothing different to test.

The gateway secret must be set on `atlas-marketing-workspace` too. It could instead be a distinct
`ATLAS_PUBLISHER_KICK_SECRET` accepted only for `action=kick`, which gives separate rotation and blast
radius. The separate secret is recommended.

---

## 7. Approval gating (enforced in SQL at claim time and again at begin_submit)

### 7.1 Fingerprint

`atlas_private.marketing_content_fingerprint(c marketing_content_items, targets jsonb) returns bytea` =
`sha256(convert_to(canonical_json, 'UTF8'))` over:

* the caption text (normalised line endings, not trimmed);
* the ordered media list `[{storage_path, sha256, mime, width, height}]`, taken from the media-library
  design's asset rows (hash, not URL);
* `content_type` and the per-target options (placement, TikTok privacy level, FB link);
* the **set of targets** `(provider_key, external_account_id, target_kind)`;
* `scheduled_for` in UTC at second precision.

Canonical JSON comes from `jsonb` (key order is normalised by jsonb output) built with an explicit
`jsonb_build_object`, never `to_jsonb(row)`, so that adding an unrelated column later does not
invalidate every approval.

### 7.2 Storage

* `marketing_content_approvals` gains `approved_fingerprint bytea` and `approved_scheduled_for timestamptz`.
  Decision rows other than `approved` leave them null.
* The `marketing_content_approve` (decide) RPC, when `decision='approved'`:
  1. computes the fingerprint;
  2. stores it on the approval;
  3. **freezes `payload_snapshot`** per target;
  4. inserts the delivery rows (`approval_id`, `approved_fingerprint`, `due_at = scheduled_for`, or
     no rows yet when unscheduled until publish-now or a schedule is set);
  5. goes through `on conflict (live target) do nothing`.

### 7.3 Gate predicate (`marketing_delivery_gate_ok`)

```
c.status in ('approved','scheduled')
and c.status not in ('cancelled','rejected')           -- explicit, for readability
and a.decision = 'approved'
and a.id = (select id from marketing_content_approvals where content_id = c.id
            order by created_at desc, id desc limit 1)  -- latest decision is this approval
and d.approved_fingerprint = a.approved_fingerprint
and atlas_private.marketing_content_fingerprint(c, <live targets>) = a.approved_fingerprint
and now() <= d.latest_acceptable_at
```

### 7.4 Edits after approval

A `BEFORE UPDATE` trigger on `marketing_content_items` recomputes the fingerprint whenever a material
column changes.

* **If any delivery is in flight** (`publishing`, `processing`, `verifying`): refuse the edit with a clear
  message ("This post is being published; wait or cancel first").
* **Otherwise, if the fingerprint changed and the status is approved or scheduled:**
  1. set content status to `draft` (or `pending_approval` if the editor resubmits in the same RPC);
  2. cancel every `queued`/`retrying` delivery with `cancelled_reason='superseded_by_edit'`;
  3. write a `content_updated` event with `approval_invalidated=true`;
  4. keep published deliveries untouched. A partially published post that is edited produces new
     deliveries only for unpublished targets on re-approval, because the partial unique index still
     holds the published row, so `on conflict do nothing` skips it.

### 7.5 Worker publishes the snapshot, never live content

Even if an edit raced the claim, the worker sends `payload_snapshot`, which is the approved text and
media. `begin_submit` re-runs the gate inside the same transaction that sets the marker, so an edit
committed between claim and submit stops the call.

---

## 8. Tests

### 8.1 SQL preview scripts (existing pattern: `scripts/verify_*_preview.sql`, one transaction, JSON verdict, rollback)

`scripts/verify_s94_publisher_preview.sql`, run by `scripts/verify_s94_previews.sh`, which is limited to
loopback addresses like `verify_s90_workflow_integrity_previews.sh`:

* Transition matrix: loop over all 9×9 status pairs. Legal pairs succeed through the owning RPC; every
  illegal pair raises `P0001`. Also `publishing→retrying` with phase `submitting` raises.
* Write-once provider IDs; `published` with no ID is refused; the partial unique live-target index
  allows re-creation after `cancelled`.
* Approval gate, each case making the claim return 0 rows:
  * an edit of the caption, schedule, media hash or target set after approval;
  * content cancelled;
  * a newer `changes_requested` decision;
  * connection not `connected`;
  * cooldown active;
  * past `latest_acceptable_at`, which instead goes to needs_attention.
* Fencing: `complete` with the wrong or expired token returns `lease_lost` and changes nothing.
* Stale-lease recovery: `publishing` with phase none → `retrying`; `publishing` with phase submitting →
  `verifying`; `processing` keeps its status and has its claim cleared.
* Budget: 25 published in 24 h for an IG account → no claim, and `next_attempt_at` is pushed.
* Backoff bounds with `setseed(0.42)`: the result is always in `[base·2^(n-1)/2, base·2^(n-1)]`, capped,
  and Retry-After wins.
* Grants: anon and authenticated get `42501` on every new RPC and table; the tick function is not
  executable by API roles.
* needs_attention enqueues exactly one push per audience member and none on repeat (§9).

### 8.2 Concurrency proof (needs committed data; run against a throw-away replay database only)

`dblink` exists in the local PG16 extension directory (VERIFIED). Two real sessions can therefore be
driven from one psql script. Fixtures must be **committed**, because another session cannot see an
uncommitted transaction. So this script does not use the rollback pattern: it creates a scratch database
`vaos_s94_concurrency` (or uses the replay DB and deletes its rows by a fixture tag in a final block).

```sql
create extension if not exists dblink;
-- seed 10 due, approved deliveries (committed)
select dblink_connect('a', 'host=127.0.0.1 port=55488 dbname=vaos_s94_concurrency user=postgres');
select dblink_connect('b', 'host=127.0.0.1 port=55488 dbname=vaos_s94_concurrency user=postgres');
select dblink_exec('a', 'begin');
select dblink_exec('b', 'begin');
-- A claims 4 and keeps its transaction (and row locks) open
create temp table claim_a as select * from dblink('a',
  $$select (x->'delivery'->>'id')::uuid from jsonb_array_elements(
      atlas_private.marketing_delivery_claim('worker-a', 4, 300)) x$$) as t(id uuid);
-- B claims 4 while A holds its locks -> must get 4 *different* rows and must not block
set statement_timeout = '3s';     -- a blocking FOR UPDATE (missing SKIP LOCKED) would fail here
create temp table claim_b as select * from dblink('b', $$ …'worker-b'… $$) as t(id uuid);
select dblink_exec('a','commit'); select dblink_exec('b','commit');
-- assertions: count(a)=4, count(b)=4, a ∩ b = ∅, every claimed row has exactly one attempt row,
-- claim_token distinct, 2 rows still queued.
```

Truly simultaneous variant: `dblink_send_query('a', …)` and `dblink_send_query('b', …)`, then
`dblink_get_result` for both, so the two claims overlap on the server.

Stress variant (pgbench is present): `pgbench -n -c 8 -j 4 -T 20 -f claim_and_complete.sql`, where each
transaction claims up to 2 rows and completes them as published through a fake outcome. Seed 500 rows,
then assert:

* `count(*) = count(distinct delivery_id)` in `marketing_delivery_attempts` where outcome='published';
* no row has more than one published attempt;
* every row is published;
* no deadlocks appear in the log.

Lease-expiry race: session A claims with a 1-second lease and sleeps 2 s
(`pg_sleep` inside the dblink query). Session B claims the same row (recovered). A's `complete` then
returns `lease_lost`, and the row's final state is B's.

Wrap it as `scripts/verify_s94_publisher_concurrency.sh`, which:

1. refuses a non-loopback PGHOST;
2. creates and drops the scratch database;
3. replays migrations into it with the existing `verify_full_migration_replay.sh` machinery.

Keep it out of the rollback-only preview runner.

### 8.3 Node tests (`tests/node/marketing-publisher-s94.test.js`; handler.mjs with injected `env`, `fetch`, `rpc`, `now`, `random`)

* **Fake store.** A small in-memory implementation of the RPC contract (claim, begin_submit,
  record_step, complete) that enforces the **same transition table**. The table is exported as JSON from
  one source file and used by both the SQL seed (generated) and the fake, so the two cannot drift.
  Optionally, a Node test drives the real SQL through `psql` when `ATLAS_TEST_PG` is set.
* **Fake providers.** A `fetch` router that records every call and can (a) succeed, (b) return an error
  body, (c) throw after "applying" the side effect, meaning a lost response, or (d) hang past the abort
  signal.

Cases:

| # | Scenario | Assertion |
|---|---|---|
| T1 | No or wrong or short secret; secret with a different length | 401 or 503; zero RPC and zero provider calls; the comparison runs over a SHA-256 digest (code-level test of the helper) |
| T2 | IG happy path, image | container → poll FINISHED → begin_submit → media_publish → published; the calls are in that order and `record_step(container)` happened **before** the first status poll |
| T3 | **IG ok, TikTok init 500 (rejected)** then tick 2 | TikTok retrying then published; the IG call count is exactly 1 media and 1 media_publish across both ticks |
| T4 | IG media_publish lost response (side effect applied) | verifying → container `PUBLISHED` → media list match → published with source verification; **one** media_publish call in total |
| T5 | IG media_publish lost response, not applied | verifying → container FINISHED → retrying → media_publish again with the **same creation_id**; one media on the fake account |
| T6 | TikTok init lost response | verifying → no `video.list` scope → needs_attention; init called once in total; notification enqueued |
| T7 | FB feed timeout, post exists | verify finds a match → published; POST /feed called once |
| T8 | FB feed timeout, post absent on 2 reads 2 min apart | one retry, then success; a second ambiguity goes to needs_attention |
| T9 | Lease lost between begin_submit and complete | `complete` returns lease_lost; the worker makes no further provider calls for that row |
| T10 | Lease lost **before** begin_submit (begin_submit returns lease_lost) | zero non-idempotent calls |
| T11 | 429 with Retry-After: 120 | retrying; next_attempt_at at least now+120 s; account cooldown set; other accounts still processed |
| T12 | Graph 190 | needs_attention('auth_expired'); integration verify_failed recorded; no retry loop |
| T13 | Stale: tick after latest_acceptable_at | no provider call; needs_attention('stale_schedule') |
| T14 | Content edited after claim, before submit (begin_submit gate fails) | no provider call; delivery cancelled (superseded) |
| T15 | 45 s budget | with a slow fake, the worker stops claiming new batches and returns before the deadline; unfinished rows keep their leases and are not half-written |
| T16 | Publish-now kick | gateway RPC then kick fetch with the kick secret; kick failure is swallowed; the response is still 200 queued |
| T17 | Logs and events never contain tokens (scan the recorded RPC payloads for `access_token`, etc.) | — |

Run them with plain `node --test` (the `npm test` glob already picks up `tests/node/*.test.js`). If the
worker imports Deno-only modules, use `tests/node/helpers/edge-function-harness.js`.

---

## 9. Notifications on needs_attention

Existing mechanisms (VERIFIED):

* `atlas_private.push_notification_queue`, with `public.atlas_push_notification_enqueue_many(audience[], event_type, title, body, route, object_id)`,
  claimed and sent by `atlas-notifications ?action=dispatch`. Delivery is gated by
  `ATLAS_PUSH_DELIVERY_ENABLED` and `ATLAS_PUSH_DISPATCH_TOKEN`.
* Domain event tables: `atlas_private.marketing_workspace_events` (CHECK list of event types) and
  `atlas_private.operations_events`.

Design:

1. **Migration changes.**
   * Extend the `push_notification_queue` CHECKs: `event_type` gains `marketing_delivery` and `route`
     gains `marketing`. Update the `enqueue_many` guard lists to match.
   * Extend the `marketing_workspace_events.event_type` CHECK with `delivery_published`,
     `delivery_needs_attention`, `delivery_failed`, `delivery_requeued`, `delivery_marked_posted`,
     `delivery_cancelled`, `publish_now`.
   * Add the service worker and browser route handling for `route='marketing'`, in the web app's push
     click handler. Coordinate with the UI agent.
2. **In the same transaction** that moves a delivery to `needs_attention` or `failed` (inside
   `marketing_delivery_complete` or the claim's stale path):
   * insert the `marketing_workspace_events` row, which gives in-app history and the Marketing and Home
     attention cards;
   * if `attention_notified_at is null`, call `enqueue_many`:
     * audience: active admin and manager profiles, plus the content owner if active;
     * title: "Post needs attention";
     * body: "Instagram: we could not confirm 'Friday DJ' was posted. Check and tell Atlas.", with
       the provider label and title only, never raw provider errors;
     * `object_id`: the delivery id;
   * set `attention_notified_at = now()`. Repeated verifies or ticks produce no duplicate push; a manager
     requeue resets it.
3. **Dispatch.** Nothing schedules the push dispatch today. Add a second cron job (`'* * * * *'`, only
   when pending rows exist) that calls `atlas-notifications?action=dispatch` the same way as §1.4.
   Before that, fix the two gaps in `atlas-notifications`:
   * constant-time token comparison;
   * a lease/stale recovery for `processing` rows (`attempted_at < now() - 10 min` → back to pending,
     with a bounded retry count).

   Production runs that function with `verify_jwt=true`. A pg_net caller would then also need a JWT
   `Authorization` header. Either redeploy with `verify_jwt=false` and rely on the dispatch token (which
   matches the rest of Atlas), or send the legacy service_role JWT from Vault. The first is recommended,
   given the docs' direction away from JWT keys.
4. **Integrations surface.** `auth` class errors also call `integration_record_result('verify_failed')`,
   so the Settings → Integrations card shows "Reconnect Instagram". This way the notification leads
   somewhere actionable.
5. **Digest safety net.** A daily 08:45 venue-time Home card, not a push, lists deliveries still in
   `needs_attention` and `verifying` older than 1 h. Iceland is UTC all year, but compute the time
   through `atlas_private.venue_timezone()` so the logic does not hard-code it.

---

## 10. Time and venue clock

* Every stored instant is `timestamptz` (UTC). `due_at` is the approved `scheduled_for`.
* The UI captures "date + HH:MM" in venue time with `AtlasVenueClock.zonedToInstant(dateKey, 'HH:MM')`
  and displays with `formatDateTime`. The server validates it with
  `(p_local_ts at time zone atlas_private.venue_timezone())`.
* Iceland has no DST today, so the zone is effectively UTC. The code must still never assume `+00:00`:
  if the venue setting changes, stored instants stay correct because they are absolute.
* The "latest acceptable" defaults and the digest use venue dates (`atlas_private.venue_date(now())`).
  Business-day logic (`venue_business_date`) is not needed for posting.

---

## 11. Rollout order (for the implementation track)

1. Migration (replayable, no extensions):
   * deliveries, attempts, provider accounts and the transitions table;
   * the trigger, RPCs, fingerprint and approval columns;
   * the notification CHECK extensions;
   * the `marketing_publisher_tick()` definition.
2. Run the SQL previews, the concurrency script (local) and the Node tests.
3. Deploy `atlas-marketing-publisher` (`verify_jwt=false`) with `ATLAS_PUBLISHER_ENABLED=false`, so every
   tick answers `{disabled:true}` with no claims.
4. Owner step: `create extension pg_net with schema extensions; create extension pg_cron;`, then the Vault
   secrets and the function secrets (tick and kick), then `cron.schedule`. Update DEPLOYMENT.md: replace
   the stale "drop pg_net from public" note with "pg_net lives in `extensions` and is used by the
   publisher tick".
5. Set the flag to true. First run with a dry-run provider mode (`ATLAS_PUBLISHER_DRY_RUN=true`, where
   the providers are fakes that log) against one test content item. Then one real IG post to the
   venue's account, approved by the owner.
6. Kill switch: `select cron.unschedule('atlas-marketing-publisher-tick')` and/or
   `ATLAS_PUBLISHER_ENABLED=false`. In-flight rows recover through the lease rules on re-enable.

---

## 12. Open questions for the other S94 designs

* Content and media model: the canonical media asset row (storage path, sha256, dimensions) used by the
  fingerprint. Is `platforms text[]` superseded by explicit targets?
* Credentials: move the AES-GCM helpers to `_shared` for the worker; decide the refresh-token ownership
  (worker vs `atlas-integrations`), and prevent concurrent refresh with an
  `advisory_xact_lock(hashtext('refresh:'||provider))`.
* Provider app review: IG `instagram_business_content_publish` (or `instagram_content_publish`), FB
  `pages_manage_posts`, TikTok `video.publish` (+ `video.list` for verification) and the TikTok
  domain/URL-prefix verification for PULL_FROM_URL. All UNVERIFIED here; these belong to the provider
  research track.
* Whether publish-now should require re-approval (recommendation: no, see §6).

---

## Sources

Supabase (fetched through the Supabase docs MCP `search_docs`, because supabase.com is blocked for WebFetch):

* Scheduling Edge Functions: https://supabase.com/docs/guides/functions/schedule-functions (pg_cron + pg_net + Vault example)
* Supabase Cron: https://supabase.com/docs/guides/cron (at most 8 concurrent jobs, under 10 min each, `cron.job_run_details`, second-level schedules)
* pg_net: https://supabase.com/docs/guides/database/extensions/pg_net (async, requests start after commit, default timeout 2000 ms, unlogged tables, 6 h TTL, about 200 req/s)
* Vault: https://supabase.com/docs/guides/database/vault (`vault.create_secret`, `vault.decrypted_secrets`, protect access)
* Automatic embeddings (pg_cron + pgmq + pg_net + Edge Functions pattern): https://supabase.com/docs/guides/ai/automatic-embeddings
* Supabase Queues: https://supabase.com/docs/guides/queues (pgmq, "exactly once within a visibility window")
* Migrating to publishable and secret API keys: https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys (`verify_jwt=false`, the `apikey` header for pg_net, Vault for keys, legacy keys until the end of 2026)
* API keys: https://supabase.com/docs/guides/getting-started/api-keys
* Edge Function limits: https://supabase.com/docs/guides/functions/limits (150 s idle timeout, 150/400 s wall clock, 2 s CPU)
* CPU limits troubleshooting: https://supabase.com/docs/guides/troubleshooting/edge-function-cpu-limits

Providers (official pages blocked by the egress proxy, so these claims are UNVERIFIED and rest on search snippets):

* Meta, Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/ (100 posts per rolling 24 h, `content_publishing_limit`, containers expire after 24 h)
* Meta, IG User Media reference: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ (status_code FINISHED, ERROR, EXPIRED, IN_PROGRESS; PUBLISHED per https://tiagogrosso.github.io/instagram-graph-api-lib/enums/CONTAINER_STATUS_CODE.html)
* Meta, Page published_posts: https://developers.facebook.com/docs/graph-api/reference/page/published_posts/ ; guidance on no idempotency and reconciling ambiguous timeouts: https://blog.dohoo.ai/blog/facebook-graph-api-publishing/
* TikTok, Get Post Status: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status ; Direct Post: https://developers.tiktok.com/docs/en/content-posting-api-get-started (6 init/min, 30 status fetch/min per user token, PUBLISH_COMPLETE; rate-limit numbers from https://www.tokportal.com/learn/tiktok-content-posting-api-developer-guide)

Repository (worktree `/home/user/-V-OS-/.claude/worktrees/s94`):

* `docs/DEPLOYMENT.md:71`: the stale pg_net note
* `supabase/migrations/20260926090000_s88_venue_clock.sql`, `apps/web/assets/js/atlas-venue-clock.js`
* `supabase/migrations/20260911124039_s34_notification_and_conversation_stars.sql`: the push queue, claim with SKIP LOCKED, no lease
* `supabase/functions/atlas-notifications/index.ts:81-82`: the non-constant-time dispatch token compare
* `supabase/functions/atlas-ai/handler.mjs:129,812`: `timingSafeEqual`, service secret of at least 32 characters
* `supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql`: the content, approvals and events schemas
* `supabase/migrations/20260926095000_s88_integrations_oauth.sql`: credentials keyed by provider_key, the service-role-only pattern
* `supabase/functions/atlas-integrations/index.ts`: the service-role RPC fetch pattern
* `scripts/verify_s90_workflow_integrity_previews.sh`: the loopback-only preview runner pattern
* `tests/node/helpers/edge-function-harness.js`: running Deno functions under Node with injected fetch

Production metadata queries (read-only, project dnefgcmjcgxlynycxkts): `pg_extension`, `pg_available_extensions`,
`pg_namespace` (no cron, net or pgmq), `version()`, `TimeZone`, marketing, push and venue tables and functions
present, and `list_edge_functions` (`atlas-notifications` verify_jwt=true; the others false).
