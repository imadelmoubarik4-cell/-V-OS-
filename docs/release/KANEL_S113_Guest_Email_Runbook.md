# KANEL S113 — Guest booking emails from kanel@kanel.is

Guests who book on kanel.is get an email from **kanel@kanel.is** when their request arrives, when it is confirmed, changed, declined or cancelled. Each email is written in the language of the page they booked on (English or Icelandic).

Owner decisions (26 Oct 2026):
- Send through KANEL's own Google Workspace mailbox.
- Discard the emails queued before sending was switched on.
- Write each email in the guest's site language.

## How it works

1. A booking event queues a row in `atlas_private.booking_email_outbox` (S108 trigger, unchanged).
2. Every minute, pg_cron runs `atlas_private.booking_email_tick()`. When something is due, it wakes the Edge Function `atlas-booking-email-worker` through pg_net, with a secret header. The secret is generated in Vault and nobody ever copies it.
3. The worker claims the due emails (`atlas_booking_email_claim`). The database renders each one as plain text in the guest's language, with the reference, date, time, guests and stools.
4. The worker logs in to `smtp.gmail.com:465` as kanel@kanel.is with a Google app password and sends the email. It then records the result (`atlas_booking_email_complete`).

Safety rules (all in the database):
- **Owner switch** `booking_settings.guest_email_enabled` is OFF after install. While it is off, guests get no email and the website promises none. A test email to kanel@kanel.is still goes, so delivery can be proven first.
- **Never late:** an email older than 24 hours, about a booking that has passed, or queued before the switch was turned on is discarded.
- **At most once:** if the connection drops after the message was handed over, the email is marked failed and never sent again.
- **Retries:** temporary refusals retry after 5, 10, 15 and 20 minutes, then fail. A refused login puts every claimed email back in the queue.
- Responses and stored errors carry counts and SMTP codes only. They never contain an address or the password.

## Owner steps (Google and Supabase, done by the owner)

1. **App password.**
   - Sign in to Google as **kanel@kanel.is**. 2-Step Verification must be on for that account.
   - Open <https://myaccount.google.com/apppasswords>, create one named `Alcedo booking emails`, and copy the 16 letters.
   - If the page says app passwords aren't available, the Workspace admin must allow 2-Step Verification for the account first.
2. **Supabase secret.**
   - Open Supabase → project *vabar-inventory* → Edge Functions → **Secrets**.
   - Add `BOOKING_EMAIL_SMTP_PASSWORD` with the 16 letters. Spaces are fine; the worker removes them.
   - Never paste the password into chat, email or the repo.

To stop all sending at any time, run `select cron.unschedule('kanel-booking-email');`, or delete the secret.

## Production install (Claude, each step with owner approval)

Order matters. Production is at S112 before this.

1. Run `docs/release/sql/KANEL_S113_preflight_readonly.sql`. Continue only with no FAIL rows.
2. Run `docs/release/sql/KANEL_apply_9_s113_booking_guest_email.sql`. The emails still queued are discarded (owner decision).
3. Deploy the Edge Functions:
   - `atlas-public-booking` 0.4.0, which forwards the site language.
   - `atlas-booking-email-worker`, which is new.
   - Both use `verify_jwt = false`.
4. Create the Vault secret `atlas_project_url`, unless it already exists. Its value is the project URL `https://<ref>.supabase.co`:
   `select vault.create_secret('https://<ref>.supabase.co', 'atlas_project_url');`
5. Run `scripts/kanel_booking_email_schedule_install.sql`. It:
   - enables pg_net
   - generates the worker secret in Vault
   - schedules `kanel-booking-email` every minute
6. After the owner has set `BOOKING_EMAIL_SMTP_PASSWORD`, queue a test email with `select atlas_private.booking_email_queue_test();`.
   - Within a minute it should arrive in kanel@kanel.is. Check its status with `select status, error from atlas_private.booking_email_outbox where kind = 'test' order by created_at desc limit 1;`.
7. Once the test email has arrived and the owner approves, run `update atlas_private.booking_settings set guest_email_enabled = true where id = true;`.
8. Upload the website build that sends the site language and shows the email line.

## Rollback

- **Stop sending only:** `scripts/kanel_booking_email_schedule_uninstall.sql`. You can also switch emails off with `update atlas_private.booking_settings set guest_email_enabled = false where id = true;`.
- **Full rollback:** `docs/release/sql/KANEL_S113_rollback.sql`. It is generated, one transaction and idempotent. It:
  - stops the schedule
  - restores the S112 request RPC
  - drops the S113 functions and trigger
  - deletes test emails only
  - restores the S112 outbox kind rule
  - turns the switch off
  - removes the ledger row

  The added columns are kept unless their commented lines are enabled. Afterwards, delete the Edge Function `atlas-booking-email-worker` and the secret `BOOKING_EMAIL_SMTP_PASSWORD`. Redeploy `atlas-public-booking` 0.3.0 only if needed: 0.4.0 works against S112 too, where the language is ignored.

## Verification (CI)

- `scripts/verify_s113_booking_guest_email.sh` runs the database acceptance.
- `tests/node/booking-email-worker-s113.test.js` tests the worker against a scripted SMTP server.
- `tests/node/public-booking-s113.test.js` tests the language forwarding.
- `scripts/release/verify_kanel_bookings_rollback.sh` rolls back S113…S106 and re-applies bundles 1–9.

Icelandic email wording needs a native proofread. The texts are in `atlas_private.booking_email_render`.
