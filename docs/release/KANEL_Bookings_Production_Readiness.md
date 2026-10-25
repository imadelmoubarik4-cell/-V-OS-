# KANEL × ALCEDO Online Bookings — Production Readiness Checklist

Status: **DRAFT / not released.** Everything below is built, tested and merged into
PR #135 only. No migration is applied to production, no edge function deployed, no
flag flipped, no email sent. Activation is owner-gated and strictly sequenced.

## What is ready (verified in PR #135)

- **Engine (s106):** online cap 4, 15-min turnaround, three fixed Bar sections
  (1–8 / 9–12 / 13–16, never crossing), non-wrapping contiguous-seat availability,
  segment rule on assign/approve/reassign, per-day last-start from each day's close.
- **Public API (s107 + s109):** scoped `atlas-public-booking` edge; independent
  server flag; sealed service-role RPCs enforce every rule; guests stay `requested`;
  unguessable token; expiring holds; transaction-safe allocation; idempotency;
  edge-committed rate limiting; trusted-hop IP; mandatory salt; off-URL token;
  restrictive CORS.
- **Staff notifications (s108 + s109):** sealed per-manager inbox + bell worker
  (event-driven, no poll), gated OFF by default; `public_token`-only trigger;
  declined/cancelled/no_show semantics; sealed, inert, de-duplicated email outbox.
- **Isolation:** two independent flags — `BOOKING_NOTIFICATIONS_ENABLED` (staff
  inbox) and `PUBLIC_BOOKING_ENABLED` (guest website/edge) — both OFF; neither
  implies the other.

## Validation evidence

### Authoritative CI (GitHub)

- `contracts` (required) and `replay` (required): **green** at `81877a6` and `af98362`.
  From this release onward, `replay` also proves the S106–S109 rollback and
  re-apply (runbook §2).
- Browser suite: **not fully green.**
  - At `81877a6` (owner-verified): 444 passed, 2 failed, 1 skipped
    (`atlas-bot:578`, `ux-acceptance:69`).
  - At `af98362` (docs-only change): 2 failed (`atlas-bot:578`,
    `home-operations:207`); `ux-acceptance` passed.
  - Evidence and classification:
    [`KANEL_PR135_Browser_CI_Evidence.md`](KANEL_PR135_Browser_CI_Evidence.md).
    `atlas-bot:578` and `ux-acceptance:69` also fail on `main` before PR #135.
    `home-operations:207` is non-deterministic on identical code, and no PR cause
    was found. No test was weakened.
- The 19 Accounting failures seen at `ada6668` are **absent** at `81877a6`.
- `disposable PostgreSQL 17` ("Production adoption dry run"): red. This is the
  `adjust_inventory` lint, which fails identically on a clean `main`. See the S106
  impact doc.

### Local checks (this environment only — distinct from CI; do not conflate)

- Migration replay: clean fresh DB, 170 migrations, `migration_replay: passed`.
- SQL acceptances: s99, s106, s107, s108, s109 — all passed.
- Node suite: 1628 pass / 0 fail (edge hardening + SW routing + observer ratchet +
  the default-OFF flag contract).
- Targeted browser (local): `bookings-notifications` 5/5, `bookings` +
  `accounting-s92` 35/35, `home-operations` + `team-messages` + `shell-ui` 29/29.
- Local `atlas-ai` + `atlas-bot`: 68/70 — the two LOCAL failures
  (`atlas-ai` "manager-only proposals"; `atlas-bot` "idle falls asleep") are
  **different tests/assertions** from the two CI failures above; the environments
  diverge and neither set substitutes for the other.
- Python contracts: s106/s107/s108/s109 + S42 cutover + S34 — all passed.

## Release sequence and activation gate

Superseded by the production release runbook and checklist, which reflect the
owner-confirmed production state (22 Oct 2026: S105, `atlas-public-booking` not
deployed, 30 / 0 settings):

- [`KANEL_Bookings_Release_Runbook.md`](KANEL_Bookings_Release_Runbook.md):
  exact sequence, S106 staff impact, backup, rollback tiers, secrets, flags, and
  end-to-end tests.
- [`KANEL_Go_Live_Checklist.md`](KANEL_Go_Live_Checklist.md): every action that
  needs owner approval.
- [`KANEL_Guest_Confirmation_SOP.md`](KANEL_Guest_Confirmation_SOP.md) and
  [`KANEL_Booking_Privacy_Notice.md`](KANEL_Booking_Privacy_Notice.md) (EN/IS drafts).

The KANEL website integration is done and deployed with booking **off**
(`KANEL_BOOKING.enabled:false` on Netlify `kanelbar`). Switching it on is runbook
step B8.

## Explicit non-goals of this PR

No merge, no deploy, no production DB change, no flag activation, no live email —
all await explicit owner authorisation.
