# KANEL Booking Email — Integration Readiness (prepared, not activated)

Status: the transactional-email **seam is built and inert**. No email is ever
sent by the current code. Activation is blocked only on an owner-approved email
provider + credentials. Proposed sender: **kanel@kanel.is**.

## What is built (s108)

- `atlas_private.booking_email_outbox` — a sealed (service_role-only) queue. Every
  booking lifecycle event enqueues a row with `status = 'queued'`:
  - `request_received` (guest submitted a request),
  - `confirmed` (staff approved),
  - `declined` / `cancelled` (staff rejected or cancelled),
  - `changed` (time or party changed).
- Sender address `booking_settings.booking_email_from`, default `kanel@kanel.is`.
- The lifecycle trigger populates the queue for public (source `web`) bookings and
  skips the email when the guest gave no address (staff are still alerted in-app).
- **Nothing in the app moves a row out of `queued`.** Outbound delivery is inert.

The acceptance test (`tests/sql/s108_booking_notifications.sql`) asserts every
outbox row stays `queued` — delivery cannot happen by accident.

## What completes activation (pending the owner)

1. **Choose a provider** (e.g. Resend / Postmark / SES / SMTP) and verify the
   `kanel@kanel.is` sender domain (SPF/DKIM) with it.
2. **Provide credentials as environment secrets** (never in the repo):
   `BOOKING_EMAIL_PROVIDER` (e.g. `resend`), `BOOKING_EMAIL_API_KEY` (or SMTP
   settings), and a worker secret `BOOKING_EMAIL_WORKER_SECRET`.
3. **A dispatch worker** (to be added as `atlas-booking-email-worker`, mirroring
   the secret-gated `atlas-marketing-publisher`): woken by pg_cron/pg_net, it
   drains `booking_email_outbox` rows in `queued`, sends via the provider, and
   marks each `sent` / `failed` with `sent_at` / `error`. It will:
   - do nothing (return `disabled`) while `BOOKING_EMAIL_PROVIDER` is unset,
   - authenticate a constant-time worker secret (no browser surface, no CORS),
   - be idempotent (claim a row `queued -> sending` before the provider call),
   - never expose the provider key or guest PII beyond the recipient.
4. **Templates**: the queued `subject`/`body` are plain, safe defaults; the final
   bilingual (English/Icelandic) KANEL templates are applied when the provider and
   the Moss & Stone brand assets are available (ties in with the Phase 4 website).

Until steps 1–2 are provided by the owner, the worker is intentionally not added —
it would be dead, unexercisable code. The queue preserves every intended email, so
once the provider is configured the backlog can be delivered or discarded as the
owner decides. No live email will be sent without the owner's approval.
