# KANEL × ALCEDO online bookings — production release runbook (PR #135)

**Status: preparation only. Nothing in this runbook has been executed in production.**
Every step marked **APPROVAL** needs the owner's explicit go-ahead for that step;
approval of one step does not carry over to the next. The step-by-step tick list is
[`KANEL_Go_Live_Checklist.md`](KANEL_Go_Live_Checklist.md).

Production facts this runbook starts from (confirmed by the owner, 22 Oct 2026):

| Fact | Value |
|---|---|
| Supabase project | `dnefgcmjcgxlynycxkts` |
| Last applied migration | `20261022090000` (S105). S106–S109 **not** applied |
| `atlas-bookings` edge function | deployed (staff bookings), from `main` |
| `atlas-public-booking` edge function | **not** deployed |
| Guest RPCs, notification tables | not installed |
| `booking_settings` | `max_party_online = 30`, `turnaround_minutes = 0` |
| Business hours | Sun–Thu 11:30–22:00, Fri–Sat 11:30–23:59 (**owner to confirm**) |
| kanel.is | live on Netlify `kanelbar`, booking switched **off** (`KANEL_BOOKING.enabled:false`). **Not touched by this release.** |
| app.alcedo.is | Netlify, deploys automatically from `main` |

The release has two phases with an owner decision between them:

- **Phase A — install, everything off.** Database, staff edge function and web app.
  Guests cannot reach anything. Staff booking rules change (S106, below).
- **Phase B — activation.** Separate approval, later. Hours, secret, three flags,
  then the website switch.

Email delivery (Phase C) is not part of this release.

---

## 1. What S106 changes for existing staff bookings

S106 changes the booking engine for **all** bookings, staff-created ones included.
Full analysis: [`S106_Bookings_Engine_Production_Impact.md`](S106_Bookings_Engine_Production_Impact.md).

| Rule | Today (S105) | After S106 | Who is affected |
|---|---|---|---|
| Turnaround between bookings on the same seat | 0 min | **15 min** | Staff and web. Back-to-back bookings on one stool closer than 15 min are refused for new bookings and re-assignments. |
| Bar layout | 16 stools in a ring (16 is next to 1) | **Three fixed sections**: A = Bar 1–8, B = Bar 9–12, C = Bar 13–16. No wrap from 16 to 1. | Staff auto-assign and manual multi-stool assignment can no longer span 8\|9, 12\|13 or 16\|1. |
| Online party size | up to 30 | **1–4** | **Web bookings only.** Staff can still book any size. |
| Latest start time | not derived | **Closing time − 2 h**, on the 15-min grid from opening | Online availability. Staff bookings are not limited by it. |

**Existing reservations are not modified or cancelled.** The rules apply when a
booking is created or (re)assigned. An existing booking that breaks a new rule keeps
its seats. Re-assigning it may be refused, so staff should pick another stool.

The preflight (§3) lists every future booking that breaks a new rule, in its
`impact` rows. Review that list **before** applying. Usually that means moving a
booking by 15 min or to another stool.

## 2. Release artefacts (all in this PR, all tested in CI)

| File | Purpose |
|---|---|
| `docs/release/sql/KANEL_preflight_readonly.sql` | One read-only `SELECT`. Checks the ledger is at S105, the two functions and two constraints S106–S109 rewrite still match the repo's S105 text (no drift), none of the release objects exist yet, the Bar layout, hours and latest online start per weekday, and staff bookings the new rules affect. |
| `docs/release/sql/KANEL_apply_1_s106_bookings_engine.sql` … `KANEL_apply_4_s109_booking_notifications_inbox.sql` | The four migrations, one transaction each. Each refuses unless the previous migration is recorded and its own is not, then embeds the migration file unchanged and writes its ledger row. |
| `docs/release/sql/KANEL_S106_S109_rollback.sql` | Single-transaction, idempotent rollback to the exact S105 definitions. Works from any partial state. |
| `scripts/release/kanel_bookings_snapshot.sql` | Read-only structural snapshot (JSON) for the release record. |
| `scripts/release/verify_kanel_bookings_rollback.sh` | Last step of the `Migration replay` CI gate. On a replayed database it proves: rollback → S105 (main's original staff acceptance passes again) → bundles refuse out-of-order and repeat runs → re-apply → S106–S109 acceptances pass. |

> **Never run `supabase db push` against production.** The production ledger is a
> squashed baseline, so a push would try to replay old history. Apply only the four
> bundles, in order.

---

## 3. Phase A — install with everything off

### A0. Staging rehearsal (recommended) — **APPROVAL** (creates a billable Supabase branch)
1. Create a Supabase preview branch (or a scratch project) restored from production.
2. Run A1 → A4 and A6 → A7 against it exactly as written below.
3. Run the end-to-end tests in §6.1 with the staging edge flags on (staging only).
4. Run the rollback (§5, tier 2), then the preflight again. It must pass, except the
   `settings` row, which is INFO. Then re-apply the bundles.
5. Delete the branch.

### A1. Preflight (read-only) — no approval needed, but share the output
- Supabase dashboard → SQL editor → paste `KANEL_preflight_readonly.sql` → run.
  Export the result as CSV and keep it with the release record.
- **Go only if there is no `FAIL` row.** The owner decides on every `WARN` row:
  - `impact / back-to-back …` WARN: future bookings closer than 15 min on one
    stool. Leave them as they are (allowed), or move them now.
  - `impact / multi-stool … cross sections` WARN: future Bar groups spanning
    8|9, 12|13 or 16|1. They keep their seats, but can't be re-assigned
    unchanged.
  - `drift` FAIL: production differs from the repo's S105. **Stop.** The rollback
    script would restore the wrong definition. Investigate first.

### A2. Backup — **APPROVAL** (reads production data to a local file)
1. Dashboard → Database → Backups. Record the time of the latest daily backup. If
   point-in-time recovery (PITR) is enabled, record the current time as the restore
   target. If PITR is not enabled, the daily backup plus step 2 is the fallback.
2. Export the booking tables. This contains guest personal data, so keep the file
   encrypted and delete it when the release is signed off:
   ```bash
   pg_dump "$PROD_DB_URL" --data-only --no-owner \
     -t atlas_private.booking_settings -t atlas_private.booking_areas \
     -t atlas_private.booking_tables -t atlas_private.booking_table_combinations \
     -t atlas_private.reservations -t atlas_private.reservation_tables \
     -t atlas_private.reservation_status_history -t atlas_private.booking_holds \
     -t atlas_private.booking_events -t atlas_private.settings_business_hours \
     -t atlas_private.push_notification_queue \
     -f kanel_bookings_pre_s106_$(date +%Y%m%d%H%M).sql
   pg_dump "$PROD_DB_URL" --schema-only --no-owner -n atlas_private -n public \
     -f kanel_schema_pre_s106_$(date +%Y%m%d%H%M).sql
   ```
3. Save the structural snapshot: run `scripts/release/kanel_bookings_snapshot.sql`
   in the SQL editor and keep its JSON output.

### A3. Apply S106 → S109 — **APPROVAL** (production database write)
Pick a quiet time. S106 changes staff rules immediately. In the SQL editor, run
each file **whole**, in order, one at a time:

1. `KANEL_apply_1_s106_bookings_engine.sql`
2. `KANEL_apply_2_s107_public_booking_api.sql`
3. `KANEL_apply_3_s108_booking_notifications.sql`
4. `KANEL_apply_4_s109_booking_notifications_inbox.sql`

Each bundle commits its migration and ledger row together, or changes nothing. If one
fails, stop. Nothing from that bundle was applied. Either fix the cause and re-run
that bundle, or roll back (§5) whatever applied before it.

### A4. Post-apply verification (read-only)
```sql
select version from supabase_migrations.schema_migrations
 where version >= '20261022090000' order by 1;              -- 5 rows: S105..S109
select max_party_online, turnaround_minutes, public_online_enabled
  from atlas_private.booking_settings;                       -- 4, 15, false
select name, online_bookable, circular_adjacency
  from atlas_private.booking_areas order by display_order;   -- only Bar online_bookable; Bar circular false
select count(*) from atlas_private.reservations where public_token is not null;  -- 0
```
Re-running the preflight now **should** produce `FAIL` rows in `ledger`, `drift` and
`not yet released`. That proves the release is in place.

In Alcedo (staff): open Bookings for today and a future day. Create a test booking
for 2, assign seats, change its status, then cancel it. Check the Bar shows sections
A/B/C. Book two stools across 8|9 and confirm it is refused with a clear message.

### A5. Merge PR #135 — **APPROVAL** (Netlify deploys app.alcedo.is from `main`)
- Mark the PR ready, then merge once CI and approvals are green. Browser CI status:
  see [`KANEL_PR135_Browser_CI_Evidence.md`](KANEL_PR135_Browser_CI_Evidence.md).
- Both web flags ship **off** (`PUBLIC_BOOKING_ENABLED:false`,
  `BOOKING_NOTIFICATIONS_ENABLED:false`), so the web app makes no new booking
  calls. The bundle is S105-compatible, so merge order against A3 is not critical.
  Merging after A3 keeps `main` equal to production.
- After the Netlify deploy: hard-reload app.alcedo.is, open Bookings, and repeat the
  A4 staff check.

### A6. Deploy `atlas-bookings` (staff edge) from merged `main` — **APPROVAL**
```bash
git checkout main && git pull
supabase functions deploy atlas-bookings --project-ref dnefgcmjcgxlynycxkts
```
This adds the `notifications` and `notifications-read` actions (managers only). No
new secrets are needed. `verify_jwt = false` comes from `supabase/config.toml`, as
today, because the function authenticates staff itself. Then repeat the A4 staff
check.

### A7. Staff in-app booking inbox — **APPROVAL** (separate small PR)
This step is optional before Phase B, but staff need the inbox to see web requests
without refreshing Bookings.
1. A one-line PR sets `BOOKING_NOTIFICATIONS_ENABLED: true` in `apps/web/config.js`
   and re-pins its SHA-256 in
   `docs/release/Atlas_S42_Production_Cutover_Manifest.json` (the S42 contract test
   enforces the pin).
2. Merge → Netlify deploy. Managers and admins see booking notifications in the bell.
   Staff-created bookings never notify (the trigger only fires for web requests).
3. Rollback: revert that PR.

### A8. Deploy `atlas-public-booking`, switched off — **APPROVAL**
```bash
supabase secrets set --project-ref dnefgcmjcgxlynycxkts PUBLIC_BOOKING_ENABLED=false
supabase functions deploy atlas-public-booking --project-ref dnefgcmjcgxlynycxkts --no-verify-jwt
```
Smoke tests. Both must hold, and no guest data is touched:
```bash
EP=https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-public-booking
curl -si -X OPTIONS -H 'Origin: https://kanel.is' "$EP" | grep -i 'HTTP/\|access-control-allow-origin'
#   → 204, access-control-allow-origin: https://kanel.is
curl -si -H 'Origin: https://kanel.is' "$EP?action=availability&date=$(date -d tomorrow +%F)&party_size=2" | head -1
#   → HTTP/2 404, body {"error_code":"disabled",…}
```
The live website stays in preview mode and never calls this endpoint while
`KANEL_BOOKING.enabled:false`.

**End of Phase A.** Guests cannot book. The DB flag `public_online_enabled=false`
and the edge flag `PUBLIC_BOOKING_ENABLED=false` each block guests on their own.

---

## 4. Phase B — activation (separate approval, later)

Order matters. Each switch is independent, so turning any one off stops guest
booking.

| # | Action | Approval |
|---|---|---|
| B1 | **Confirm opening hours** in Alcedo → Settings → Business hours. The engine offers start times from open to close − 2 h. With today's values, Sun–Thu last start is **20:00**. Fri–Sat at **23:59** gives a last start of **21:45**. Setting Fri–Sat to close **00:00 (next day)** gives **22:00** and matches the website's "until midnight" text. Owner decides. | **APPROVAL** (hours change) |
| B2 | Decide the guest-confirmation routine and response time ([`KANEL_Guest_Confirmation_SOP.md`](KANEL_Guest_Confirmation_SOP.md)), and publish the privacy notice ([`KANEL_Booking_Privacy_Notice.md`](KANEL_Booking_Privacy_Notice.md)) after legal review. | Owner decision |
| B3 | Set the salt: `supabase secrets set --project-ref dnefgcmjcgxlynycxkts PUBLIC_BOOKING_SALT="$(openssl rand -hex 32)"`. Never commit it or paste it in chat. Without a salt of at least 16 characters, the function answers 503 to every enabled call (fail-safe). | **APPROVAL** (secret) |
| B4 | Check `PUBLIC_BOOKING_TRUSTED_HOPS` (default 1). See §6.2 check 5. If it is wrong, all guests share one rate-limit bucket (8 requests / 10 min in total). | **APPROVAL** if changed |
| B5 | Edge flag: `supabase secrets set … PUBLIC_BOOKING_ENABLED=true`. The endpoint now answers, but the DB flag still refuses. | **APPROVAL** (flag) |
| B6 | DB flag: `update atlas_private.booking_settings set public_online_enabled = true where id = true;` | **APPROVAL** (flag) |
| B7 | Live API test from a terminal (§6.2) while the website is still in preview mode. Cancel the test booking afterwards. | part of B6 approval |
| B8 | Website: in kanel.is `assets/site.js`, set `KANEL_BOOKING.enabled:true`, bump the asset cache-buster in the 16 `index.html` files, upload to Netlify `kanelbar`. **Not prepared by this release.** It is a separate, owner-approved website change. | **APPROVAL** (website deploy) |

`PUBLIC_BOOKING_ORIGINS` is optional. Leave it unset unless the site moves; the
default is `https://kanel.is,https://www.kanel.is`.

## 5. Rollback (fastest first)

| Tier | When | Action | Effect |
|---|---|---|---|
| 0 | Guests must stop booking now | `update atlas_private.booking_settings set public_online_enabled = false where id = true;` **and/or** `supabase secrets set … PUBLIC_BOOKING_ENABLED=false` | Immediate. Website shows "online booking isn't available". Existing requests stay for staff. |
| 0w | Website form should disappear | Netlify `kanelbar` → Deploys → publish the previous deploy | Website back to preview mode |
| 1 | Staff rules are the problem, schema is fine | `update atlas_private.booking_settings set max_party_online = 30, turnaround_minutes = 0 where id = true;` | Turnaround back to 0. Sections stay. |
| 2 | Remove S106–S109 behaviour | Run `KANEL_S106_S109_rollback.sql` (one transaction, idempotent, CI-proven) **after tier 0**. Then redeploy `atlas-bookings` from `e14ccf6` and delete `atlas-public-booking`: `supabase functions delete atlas-public-booking --project-ref dnefgcmjcgxlynycxkts`. Revert the A7 PR if it was merged. | Staff functions, constraints and settings return to their exact S105 state. Release functions, trigger and ledger rows are removed. The new tables and columns are kept (inert, data preserved). Re-applying later uses the same bundles. |
| 3 | Data damage | PITR restore to the A2 timestamp (or the daily backup), or reload the A2 `pg_dump` | **Loses all writes after the restore point.** Last resort. |

Web app rollback: Netlify → app.alcedo.is → publish the previous deploy (or revert
the merge on `main`). The old web bundle works on S109.

Tier 2 also deletes queued booking web-push rows (inert; delivery is disabled).
Dropping the new tables and columns is commented out at the end of the script. That
is a separate, destructive decision; export first.

## 6. End-to-end tests

### 6.1 Already automated (CI, every push)
- `Migration replay`: full replay plus the S99/S106/S107/S108/S109 acceptances, then
  the rollback and re-apply proof described in §2.
- Node and Python contracts: the edge handlers (`tests/node/public-booking-s107.test.js`,
  `edge-auth-contract.test.js`), the flags (`bookings-notifications-flag.test.js`),
  `verify_jwt` policy, the S42 pin, and the release tooling
  (`tests/python/test_kanel_release_tooling.py`).
- Browser: `bookings-notifications.browser.test.mjs`, plus the full suite (see the CI
  evidence document for its open, unrelated failures).
- Website (outside this repo): 13 mocked tests against the real edge handler code.

### 6.2 Live, during activation (B7), from a terminal
```bash
EP=https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-public-booking; O='Origin: https://kanel.is'
D=$(date -d '+3 days' +%F)
curl -s -H "$O" "$EP?action=availability&date=$D&party_size=2"          # 1. slots[] within hours
curl -s -H "$O" "$EP?action=availability&date=$D&party_size=5"          # 2. 400 invalid_request
K=$(uuidgen); S=<a slot from step 1>
curl -s -H "$O" -H 'content-type: application/json' -H "idempotency-key: $K" -X POST "$EP?action=request" \
  -d '{"party_size":2,"start_at":"'$S'","guest_name":"KANEL TEST","guest_email":"<owner>","guest_phone":"<owner>"}'
                                                                          # 3. status "requested", reference KA-…
# repeat the same POST with the same key                               # 4. same reference (no duplicate)
```
5. Check fingerprints are per client: make one availability call from a second
   network (e.g. phone hotspot), then
   `select count(distinct split_part(fingerprint, ':', 1)) from atlas_private.booking_public_rate;`
   It must be ≥ 2. If it is 1, fix `PUBLIC_BOOKING_TRUSTED_HOPS` before B8.
6. In Alcedo: the request shows as **requested** with a hold. The manager inbox shows
   it (if A7 is done). Press **Cancel** on it (recorded as *declined*), then check `booking_email_outbox` has queued rows
   that were **not sent**.
7. `curl -s -H 'Origin: https://evil.example' -X OPTIONS -i "$EP"`: the allow-origin
   header must be `https://kanel.is`, never the evil origin.

### 6.3 After B8 (website)
On kanel.is and /is/bokanir/, a party of 2 tomorrow should offer times only within
the hours. Submit; you see the KA- reference and "not a confirmed reservation".
Staff cancel the request (recorded as declined) and phone the guest. Then try a party of 5: the page
links to "get in touch" and no request is created.
