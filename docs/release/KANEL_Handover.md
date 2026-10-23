# KANEL × ALCEDO online bookings — handover (as of 23 Oct 2026)

Read this first in a new chat. Then read, in this order:
[`KANEL_Go_Live_Checklist.md`](KANEL_Go_Live_Checklist.md) →
[`KANEL_Bookings_Release_Runbook.md`](KANEL_Bookings_Release_Runbook.md) →
[`evidence/KANEL_A2_Backup_Evidence_20261022.md`](evidence/KANEL_A2_Backup_Evidence_20261022.md).

## 1. Where things are

| Item | Value |
|---|---|
| Repo | `imadelmoubarik4-cell/-V-OS-` |
| Branch | `claude/kanel-online-bookings` (head `a67364e` at handover, or later) |
| PR | **#135**, **draft**, not merged. Base `main` at `e14ccf6` (main has not moved). |
| Supabase project | `dnefgcmjcgxlynycxkts` (`vabar-inventory`), region **eu-west-1**, Postgres 17.6 |
| Production DB | **S105** (`20261022090000`). S106–S109 **not applied**. |
| Edge functions | `atlas-bookings` deployed (from main). `atlas-public-booking` **not deployed**. |
| Production settings | `max_party_online = 30`, `turnaround_minutes = 0`; 0 reservations |
| Staff web app | app.alcedo.is, Netlify; deploys automatically on merge to `main` |
| KANEL website | kanel.is, Netlify project `kanelbar`; deployed by the owner with booking **off** (`KANEL_BOOKING.enabled:false`). **Do not touch it or prepare another package.** |

## 2. Standing rules from the owner (non-negotiable)

- Every gated action needs **explicit owner approval for that action**. Approval
  does not carry over to the next step.
- Do **not**: merge PR #135, apply S106–S109, deploy edge functions, change
  secrets or flags, change opening hours, send emails, activate bookings, or change
  kanel.is.
- Keep PR #135 a draft. Never describe a requested booking as confirmed.
- Never weaken, skip or retry tests to get green.
- Never use `supabase db push` on production (squashed ledger baseline). Use only the
  four apply bundles, in order.
- Normal commits only (no amend or force-push). Commit trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the session link.
- Keep CI evidence (GitHub) separate from local results. Never classify a failure
  as baseline without evidence.

## 3. What is built (in PR #135)

- **S106** engine: online cap 4, 15-min turnaround, fixed Bar sections 1–8 / 9–12 /
  13–16 (no wrap), last online start = close − 2 h.
- **S107 / S109** public API (`atlas-public-booking`): sealed service-role RPCs,
  requests stay `requested`, 15-min expiring hold, idempotency, rate limits,
  mandatory salt, trusted-hop IP, restrictive CORS. Off unless BOTH the edge
  `PUBLIC_BOOKING_ENABLED=true` and the DB `public_online_enabled=true` are set.
- **S108 / S109** staff inbox (`BOOKING_NOTIFICATIONS_ENABLED`, off) and a sealed
  guest-email outbox (nothing is ever sent).
- **Release tooling** (CI-proven, last step of `Migration replay`):
  - `docs/release/sql/KANEL_preflight_readonly.sql`: read-only preflight
  - `docs/release/sql/KANEL_apply_{1..4}_*.sql`: one guarded transaction per migration
  - `docs/release/sql/KANEL_S106_S109_rollback.sql`: exact S105 restore, ledger rows cleared
  - `scripts/release/verify_kanel_bookings_rollback.sh`: rollback → pre-S106 staff
    test passes → bundles refuse out-of-order/repeat → re-apply → S106–S109 tests pass
- **Docs** in `docs/release/`: runbook, go-live checklist, browser CI evidence,
  privacy notice (EN/IS draft), guest confirmation SOP, B0 refresh spec, A2 evidence.

## 4. Gate status

| Step | Status |
|---|---|
| A0 staging rehearsal | not requested |
| **A1 preflight** | ✅ **done** by the owner from `b26b82e`: 17 PASS / 13 INFO / 0 WARN / 0 FAIL |
| **A2 backup** | ✅ **COMPLETE** (23 Oct 2026; owner-confirmed; physical backup not restore-tested) |
| A2.9 fresh preflight | **mandatory** immediately before A3.1 |
| A3.1–A3.4 apply S106–S109 | **not approved**. The owner will authorise the next stage separately. |
| A4–A8, B0–B9, Phase C | not approved |

## 5. A2: complete (23 Oct 2026). History below

Update: the owner chose option (a). The archive was re-encrypted to the owner's GPG key (`4E1B 6BE0 5AA8 D574 BBDB 4463 A198 A517 34A2 DA58`), delivered, and the owner confirmed decryption and both hashes. The passphrase-protected original, its passphrase and the temporary keyring were shredded. Final evidence: `evidence/KANEL_A2_Backup_Evidence_20261022.md`.

Done (read-only Management API; nothing in production changed):
- Supabase backups: **PITR disabled**. Latest daily physical backup id `2034882394`,
  COMPLETED **2026-10-22 04:46 UTC**. Its restore is **not verified**.
- Logical export (2026-10-22 21:43 UTC) of the 11 booking tables, 52 rows (0
  reservations), with server-side checksums. Plus the full catalog of
  `public`/`atlas_private` and the structural snapshot. The drift check passes.
- Verified: restored into a local S105 database, 11/11 checksums match (also from
  the decrypted archive). The apply → rollback rehearsal on that copy passed.
- Encrypted archive `KANEL_A2_pre_s106_backup_20261022.tar.gpg` (GnuPG AES-256),
  SHA-256 `77f01145d74ee1cbfbee269a2058997beb7bfbb23c8353056f5b44d220273bd0`.
  **Already sent to the owner as a file.** All plaintext copies were deleted.

Open: the owner must decide all three.
1. **Passphrase.** It exists **only** in the old session's container
   (`…/scratchpad/a2_passphrase.txt`). It is not in git and not in chat. A new chat
   cannot read it. Before leaving the old chat, the owner either supplies an age/GPG
   public key there (preferred: re-encrypt to it) or asks for it to be shown once.
   If it is lost, **re-run the export** (read-only, about a minute; method in §7).
2. **Closing A2.** Pick one: (a) accept the verified logical export plus the tested
   rollback; (b) approve a test restore of backup `2034882394` to a temporary,
   billable project, then delete it; (c) enable PITR (paid add-on) before A3.
3. **Timing.** Run A3 soon after the next daily backup (~04:45 UTC), together with the
   A2.9 fresh preflight. Refresh the export if anything changed.

## 6. Owner decisions already recorded (22 Oct 2026)

- **Hours (planned; production not changed):** Sun–Thu 11:30–22:00 (last online
  start 20:00). Fri–Sat 11:30–00:00 with `close_time=00:00`, `close_next_day=true`
  (last online start 22:00). This is step B1, which needs its own approval.
- **S106 rules** accepted as the basis for release. The migration itself is a
  separate approval.
- **Browser CI:** `ux-acceptance:69` (`#data` header top 1 vs 0) is an *identified
  release exception*. It fails on earlier `main` commits. This does not permit
  weakening tests or merging. Latest CI at `b26b82e`: 445 pass / 1 fail / 1 skip.
  `contracts` and `replay` are green. The "Production adoption dry run" is red,
  from the `adjust_inventory` lint, which also fails on `main`.
- **B0 alerting:** Option A planned (60-s refresh while a manager or admin has
  Alcedo visible; spec `KANEL_B0_Inbox_Refresh_Spec.md`: R1–R9 / T1–T11; keep the
  `no setInterval` contract test). **Not implemented.** Building it and enabling it
  each need approval. Interim procedure: manual 10-minute check.
- **SOP:** 10-minute review target while open, because the seat hold is 15 min. The
  staff inbox (A7) must be live before Phase B.

## 7. Practical notes for the next session

- **Production read-only SQL** (needs `SUPABASE_ACCESS_TOKEN` in the environment):
  ```bash
  body=$(python3 -c "import json,sys;print(json.dumps({'query':sys.argv[1],'read_only':True}))" "select 1")
  curl -sS -X POST -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'content-type: application/json' \
    --data-binary "$body" https://api.supabase.com/v1/projects/dnefgcmjcgxlynycxkts/database/query
  ```
  Backups: `GET https://api.supabase.com/v1/projects/dnefgcmjcgxlynycxkts/database/backups`.
  Use reads only, unless the owner approves a specific write.
- **No DB password and no `pg_dump`** in the session (local client is v16, server is v17).
- **Export method (to redo A2):** per table, `select count(*), md5(string_agg(r, E'\n'
  order by md5(r))), json_agg(j order by md5(r)) from (select row_to_json(x) j,
  row_to_json(x)::text r from atlas_private.<table> x) s`. Then restore with
  `json_populate_recordset` into a local S105 database (with
  `session_replication_role=replica`) and compare checksums.
  Tables: booking_settings, settings_business_hours, booking_areas, booking_tables,
  booking_table_combinations, reservations, reservation_tables,
  reservation_status_history, booking_holds, booking_events, push_notification_queue.
- **Local Postgres 16** for rehearsals: binaries in `/usr/lib/postgresql/16/bin`,
  run as user `postgres`, port 5433, socket `/tmp/vaos_pg/sock`, data
  `/tmp/vaos_pg/data`. This may not exist in a new container. If not, initialise it
  and replay with `scripts/verify_full_migration_replay.sh` (`PGDATABASE=vaos_replay`).
- **Tests:** `npm run -s test:node` (1628 pass), `python3 -m unittest
  tests/python/test_kanel_release_tooling.py` (7/7). One Python module fails locally
  only (`pdfplumber` not installed).
- **Browser:** `ATLAS_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`.
- **GitHub:** use the MCP `mcp__github__*` tools (`get_job_logs` with return_content).

## 8. Next actions, in order (each needs approval)

1. Owner: passphrase handling (§5.1), then the A2 closing option (§5.2).
2. Mark A2 complete in the checklist only once the chosen verification is done.
3. Request **A3 approval**. When approved: A2.9 fresh preflight (0 FAIL), then
   bundles 1→4 in the Supabase SQL editor, then A4 checks.
4. Later, each separately: A5 merge → A6 deploy `atlas-bookings` → A7 inbox flag PR →
   A8 deploy `atlas-public-booking` (disabled) → B0 Option A code/config →
   Phase B activation.

## 9. Prompt to paste into the new chat

> Continue the KANEL × ALCEDO online bookings production release for repo
> `imadelmoubarik4-cell/-V-OS-`, branch `claude/kanel-online-bookings`, draft PR
> #135. First read `docs/release/KANEL_Handover.md`, then the go-live checklist,
> runbook and A2 evidence it links. Production is at S105. A1 is done; A2 is approved
> but not complete. Follow every standing rule in the handover: no merge, migration,
> deploy, flag, secret, hours or website change, and no email, without my explicit
> approval for that specific step. My decision on closing A2 is: [a / b / c].
