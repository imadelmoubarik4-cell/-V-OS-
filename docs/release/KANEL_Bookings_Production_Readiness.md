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

## Validation evidence (local, pre-release)

- Full migration replay: clean fresh DB, 170 migrations, `migration_replay: passed`.
- SQL acceptances: s99, s106, s107, s108, s109 — all passed.
- Node suite: 1624 pass / 0 fail (incl. edge hardening + SW routing + observer ratchet).
- Browser: full bookings suite + notification suite green; **Accounting/Home/Team
  suites stay green** (worker inert by default — no unexpected booking requests).
- Python contracts: s106/s107/s108/s109 + S42 cutover + S34 — green.
- Known non-blocking CI reds, unrelated to bookings: the pre-existing
  "Production adoption dry run / disposable PostgreSQL 17" baseline
  (`adjust_inventory` lint, documented in the S106 impact doc) and the two
  documented GPU-less browser flakes (atlas-ai, atlas-bot).

## Release sequence (each step owner-approved, in order)

1. **Apply DB migrations s106→s109** to production. Review the S106 production
   impact + rollback first. No public surface added; both flags stay off.
2. **Deploy `atlas-bookings`** (authenticated staff edge, now with the inbox
   actions). Still no behaviour change until a flag is set.
3. **Enable the staff inbox:** set `BOOKING_NOTIFICATIONS_ENABLED=true` (config.js),
   re-pin the S42 manifest, deploy the web bundle. Staff-only; no guest exposure.
4. **(Separate, later) Public guest booking:** build + review the KANEL website
   form, deploy `atlas-public-booking`, then set ALL of: edge
   `PUBLIC_BOOKING_ENABLED=true` + strong `PUBLIC_BOOKING_SALT`, DB
   `public_online_enabled=true`, frontend `PUBLIC_BOOKING_ENABLED=true`.
5. **(Separate, later) Email delivery:** approve a provider + authenticated
   `kanel@kanel.is` domain, add the secret-gated dispatch worker, then drain the
   outbox. Not before.

## Pre-activation gate (must all be true before step 4)

- [ ] Owner has approved the S106 staff-behaviour changes and the production apply.
- [ ] KANEL website (Moss & Stone / kanel.is) source connected and the booking
      form built + reviewed (Phase 4 — currently BLOCKED on the source).
- [ ] `PUBLIC_BOOKING_SALT` provisioned as an edge secret (strong, ≥16 chars).
- [ ] CORS origins confirmed for the live KANEL domain(s).
- [ ] Authoritative KANEL opening hours confirmed by the owner (the engine reads
      `settings_business_hours`; they must be set to KANEL's real schedule, not a
      prior venue's).
- [ ] Rate-limit thresholds reviewed for expected live traffic.

## Explicit non-goals of this PR

No merge, no deploy, no production DB change, no flag activation, no live email —
all await explicit owner authorisation.
