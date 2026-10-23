# KANEL × ALCEDO online bookings — go-live checklist

How to use: tick each box in order. **🔒 APPROVAL** marks an action that needs the
owner's explicit approval for that action. Approval of one row does not carry over
to the next. The runbook section is in brackets:
[`KANEL_Bookings_Release_Runbook.md`](KANEL_Bookings_Release_Runbook.md).

Current state (23 Oct 2026): **production is at S109** (A3 applied 07:31 UTC). A1, A2,
A2.9, A3 and the A4 database checks are done; the A4 staff check in Alcedo is pending. Nothing has been merged, deployed or switched on. Public
reservations are off. kanel.is is untouched.

## 0. Owner decisions

Recorded 22 Oct 2026. These are planning decisions; each production action below
still needs its own approval.

- [x] **Opening hours (planned).** Sun–Thu 11:30–22:00 (last online start 20:00).
      Fri–Sat 11:30–00:00 next day: `close_time = 00:00`, `close_next_day = true`
      (last online start 22:00). **Production hours are not changed yet.** That is
      step B1, which needs its own approval. [§4 B1]
- [x] **S106 rules accepted as the basis for release:** 15-min turnaround, fixed Bar
      sections 1–8 / 9–12 / 13–16, online party size 1–4. Applying the migration is
      a separate approval (A3). [§1]
- [x] **Browser CI release exception:** the remaining `ux-acceptance:69` failure
      (`#data` header top 1 vs 0) is accepted as an **identified release
      exception**, based on the documented failures on earlier `main` commits. It
      does not permit weakening tests, and it does not approve the merge (A5).
      [`KANEL_PR135_Browser_CI_Evidence.md`]
- [ ] **Guest confirmation routine.** Proposed: review within 10 minutes while
      open, because a web request holds its seats for only 15 minutes. Owner to
      approve before Phase B. [`KANEL_Guest_Confirmation_SOP.md`]
- [x] **How staff are alerted (planning decision):** Option A, a 60-second refresh
      while an authorised manager or admin has Alcedo open and visible. It is
      specified in [`KANEL_B0_Inbox_Refresh_Spec.md`](KANEL_B0_Inbox_Refresh_Spec.md).
      Building and enabling it each need separate approval. Until then, the manual
      10-minute check is the interim procedure.
- [ ] **Privacy notice:** fill in the legal entity, kennitala, DPA (hosting region confirmed: eu-west-1, Ireland)
      and retention period, then legal and native-speaker review.
      [`KANEL_Booking_Privacy_Notice.md`]
- [ ] **Retention period** for booking data, and whether to build the clean-up job.
- [ ] **Staging rehearsal:** yes or no. If yes, approve the billable Supabase branch.

## Phase A — install, guests still blocked

| ✓ | # | Action | Approval | Evidence to keep |
|---|---|---|---|---|
| [ ] | A0 | Staging rehearsal on a Supabase branch: apply, test, roll back, re-apply, delete the branch | 🔒 APPROVAL | test output |
| [x] | A1 | Run `KANEL_preflight_readonly.sql` (read-only). No FAIL; owner decides on each WARN | — (read-only) | **Done 22 Oct 2026 by the owner, file from `b26b82e`:** 17 PASS · 13 INFO · 0 WARN · 0 FAIL. Ledger at S105; no S106–S109 rows; no future active bookings or conflicting allocations; Bar 1–16 passes all checks. Read-only; nothing changed. |
| [x] | A2 | Record the backup / PITR time; export the booking tables and schema; save the snapshot JSON; encrypt; verify | ✅ APPROVED (22 Oct) · ✅ **COMPLETE** (23 Oct 2026, owner-confirmed) | [`evidence/KANEL_A2_Backup_Evidence_20261022.md`](evidence/KANEL_A2_Backup_Evidence_20261022.md). Logical export verified restorable (11/11 checksums). Archive encrypted to the owner's GPG key (fingerprint `4E1B…DA58`), SHA-256 `d40ae31d…19f15b`. Owner confirmed download, decryption and the `.tar` hash. **Limitation:** physical backup not restore-tested (PITR off; latest daily backup 2026-10-23 04:25 UTC). |
| [x] | A2.9 | **Fresh preflight immediately before A3.1**, using the same file from the release commit. Must again show 0 FAIL, and the owner reviews any new WARN (for example, new bookings made since A1). If A3 is not started straight away, run it again. | — (read-only) — **mandatory** | CSV export, time run | **Done 07:29 UTC:** 17 PASS / 13 INFO / 0 WARN / 0 FAIL; data unchanged since A2. [`evidence/KANEL_A3_A4_Evidence_20261023.md`](evidence/KANEL_A3_A4_Evidence_20261023.md)
| [x] | A3.1 | Run `KANEL_apply_1_s106_bookings_engine.sql` | ✅ APPROVED (23 Oct 2026) | applied 07:31:18 UTC; ledger `20261023090000` |
| [x] | A3.2 | Run `KANEL_apply_2_s107_public_booking_api.sql` | ✅ APPROVED (23 Oct 2026) | applied 07:31:30 UTC; ledger `20261024090000` |
| [x] | A3.3 | Run `KANEL_apply_3_s108_booking_notifications.sql` | ✅ APPROVED (23 Oct 2026) | applied 07:31:31 UTC; ledger `20261025090000` |
| [x] | A3.4 | Run `KANEL_apply_4_s109_booking_notifications_inbox.sql` | ✅ APPROVED (23 Oct 2026) | applied 07:31:32 UTC; ledger `20261026090000` |
| [ ] | A4 | Post-apply checks (ledger S105…S109; settings 4 / 15 / `public_online_enabled=false`; zero web rows) and the staff booking check in Alcedo | — (read-only + test booking) | results | **DB checks done** (settings 4 / 15 / off; 17/17 functions and 2/2 constraints match CI-tested S109; guest RPCs service_role only). **Pending:** the staff booking check in Alcedo. [`evidence/KANEL_A3_A4_Evidence_20261023.md`](evidence/KANEL_A3_A4_Evidence_20261023.md) **BLOCKED (23 Oct): the staff UI cannot choose or move multi-stool groups; the backend lacks a capacity check on assign and a section check on explicit create. See [`KANEL_A4_Blocker_Multi_Seat.md`](KANEL_A4_Blocker_Multi_Seat.md).** A5 stays NO-GO.
| [ ] | A5 | Mark PR #135 ready and **merge**. Netlify deploys app.alcedo.is with both web flags off | 🔒 APPROVAL (merge + web deploy) | merge SHA, Netlify deploy id |
| [ ] | A6 | `supabase functions deploy atlas-bookings` from merged `main` | 🔒 APPROVAL (edge deploy) | CLI output |
| [ ] | A7 | Separate PR: `BOOKING_NOTIFICATIONS_ENABLED: true` plus the S42 re-pin; merge → Netlify | 🔒 APPROVAL (frontend flag) | PR, deploy id |
| [ ] | A8a | Secret `PUBLIC_BOOKING_ENABLED=false` | 🔒 APPROVAL (secret) | — |
| [ ] | A8b | `supabase functions deploy atlas-public-booking --no-verify-jwt` | 🔒 APPROVAL (edge deploy) | CLI output |
| [ ] | A8c | Smoke test: OPTIONS → 204 with allow-origin kanel.is; availability → 404 `disabled` | — | curl output |

## Phase B — activation (separate approval, later)

| ✓ | # | Action | Approval |
|---|---|---|---|
| [ ] | B0 | **Gate: staff are alerted to new web requests.** A7 (inbox) is live, and a manager has seen a test web request appear in the bell. With push delivery off, the bell refreshes only when the app regains focus or visibility, comes back online, or after a staff booking change. A screen left open does **not** update by itself. **Planned: Option A** (60-second refresh while visible to a manager or admin; [spec](KANEL_B0_Inbox_Refresh_Spec.md)). Gate passes when the Option A code and config are approved, deployed and checked. Until then, the manual 10-minute check applies. | 🔒 APPROVAL (Option A code PR, then config PR) |
| [ ] | B1 | Set or confirm hours in Alcedo → Settings → Business hours | 🔒 APPROVAL (hours change) |
| [ ] | B2 | Publish the privacy notice and adopt the SOP; staff briefed | Owner decision |
| [ ] | B3 | Secret `PUBLIC_BOOKING_SALT` (`openssl rand -hex 32`; never shared) | 🔒 APPROVAL (secret) |
| [ ] | B4 | Verify, or set, `PUBLIC_BOOKING_TRUSTED_HOPS` (runbook §6.2 check 5) | 🔒 APPROVAL if changed |
| [ ] | B5 | Secret `PUBLIC_BOOKING_ENABLED=true` (edge flag) | 🔒 APPROVAL (flag) |
| [ ] | B6 | `update atlas_private.booking_settings set public_online_enabled = true where id = true;` (DB flag) | 🔒 APPROVAL (flag) |
| [ ] | B7 | Live API test from a terminal (§6.2); cancel the test booking | covered by B6 |
| [ ] | B8 | kanel.is: `KANEL_BOOKING.enabled:true` plus cache-buster, upload to Netlify `kanelbar` | 🔒 APPROVAL (website deploy) — **not prepared** |
| [ ] | B9 | First real request handled end-to-end by the SOP | — |

`PUBLIC_BOOKING_ENABLED` in `apps/web/config.js` is **not** part of activation. The
staff app has no guest form. It stays `false`.

## Phase C — automated guest emails (separate project)

| ✓ | Action | Approval |
|---|---|---|
| [ ] | Choose an email provider; authenticate kanel@kanel.is (SPF/DKIM/DMARC) | 🔒 APPROVAL |
| [ ] | Build and review the dispatch worker (not built) | 🔒 APPROVAL (code + deploy) |
| [ ] | Decide what happens to the queued outbox (send or discard) | 🔒 APPROVAL |
| [ ] | Send the first email | 🔒 APPROVAL (sending email) |

## Rollback triggers (each 🔒 APPROVAL, except tier 0 in an emergency)

| Trigger | Action [§5] |
|---|---|
| Spam, abuse, wrong times offered, or staff overwhelmed | Tier 0: DB flag off and/or edge flag off (seconds) |
| Website form misbehaving | Tier 0w: Netlify `kanelbar` → publish previous deploy |
| Staff can't work with the 15-min turnaround | Tier 1: `max_party_online = 30, turnaround_minutes = 0` |
| S106–S109 must go | Tier 2: `KANEL_S106_S109_rollback.sql`, redeploy `atlas-bookings` from `e14ccf6`, delete `atlas-public-booking`, revert the A7 PR |
| Data damage | Tier 3: PITR / backup restore (loses later writes) |

## Never, at any stage

- `supabase db push` against production.
- Enabling `ATLAS_PUSH_DELIVERY_ENABLED` as part of this release.
- Telling a guest a request is confirmed before staff have approved it and contacted
  the guest.
- Committing or pasting `PUBLIC_BOOKING_SALT` or the service-role key.
